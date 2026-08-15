import { Skill } from '../core/skills';
import fs from 'fs';
import path from 'path';
import { assertWorkspacePath } from '../core/project-context';
import { projectContextFromParams, boundaryErrorResult } from './workspace-guard';

interface PatchResult {
    operation: 'add' | 'update' | 'delete' | 'move';
    path: string;
    newPath?: string;
    success: boolean;
    error?: string;
    added?: number;
    removed?: number;
}

export class ApplyPatchSkill implements Skill {
    name = 'apply_patch';
    description = 'Apply structured file patches. Supports adding, updating, deleting, and moving files.';
    inputSchema = {
        type: 'object',
        properties: {
            input: {
                type: 'string',
                description: 'Full patch contents including *** Begin Patch and *** End Patch markers',
            },
            basePath: {
                type: 'string',
                description: 'Base directory for relative paths (default: current working directory)',
            },
            dryRun: {
                type: 'boolean',
                description: 'If true, parse and validate without making changes (default: false)',
            },
        },
        required: ['input'],
    };

    async execute(params: any): Promise<any> {
        const input = String(params?.input || '');
        const projectId = typeof params?.__projectId === 'string' ? params.__projectId.trim() : '';
        const workspacePath = typeof params?.__workspacePath === 'string' ? params.__workspacePath.trim() : '';
        // Phase 23 — when bound to a project, the patch may only touch the
        // active workspace. The workspace root comes from the canonical
        // ProjectContext (never process.cwd()), and every block path is
        // asserted inside it before any filesystem mutation.
        const projectContext = projectContextFromParams(params);
        if (projectContext) {
            const root = projectContext.workspaceRoot;
            if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
                return {
                    error: 'Project workspace required. Open Projects, then choose Create workspace or Browse folders.'
                };
            }
            if (projectContext.projectId !== 'general') {
                try {
                    const base = assertWorkspacePath(params?.basePath || root, projectContext);
                    return this.applyPatch(input, base, projectContext, Boolean(params?.dryRun));
                } catch (err: any) {
                    return boundaryErrorResult(err, 'apply_patch');
                }
            }
        }
        if (projectId && (!workspacePath || !fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory())) {
            return {
                error: 'Project workspace required. Open Projects, then choose Create workspace or Browse folders.'
            };
        }
        // phase23-ok: unbound fallback (no attached project -> no workspace to violate)
        const basePath = projectId ? workspacePath : String(params?.basePath || process.cwd());
        return this.applyPatch(input, basePath, undefined, Boolean(params?.dryRun));
    }

    private async applyPatch(input: string, basePath: string, projectContext: any, dryRun: boolean): Promise<any> {

        if (!input.includes('*** Begin Patch') || !input.includes('*** End Patch')) {
            return { error: 'Patch must contain *** Begin Patch and *** End Patch markers' };
        }

        const patchContent = input
            .split('*** Begin Patch')[1]
            .split('*** End Patch')[0];

        const results: PatchResult[] = [];
        const blocks = this.parseBlocks(patchContent);

        for (const block of blocks) {
            try {
                const result = await this.processBlock(block, basePath, dryRun, projectContext);
                results.push(result);
            } catch (err: any) {
                results.push({
                    operation: block.operation,
                    path: block.path,
                    success: false,
                    error: err?.message || String(err),
                });
            }
        }

        return {
            dryRun,
            results,
            summary: {
                total: results.length,
                success: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length,
                added: results.reduce((sum, r) => sum + (r.success ? Number(r.added || 0) : 0), 0),
                removed: results.reduce((sum, r) => sum + (r.success ? Number(r.removed || 0) : 0), 0),
            },
        };
    }

    private parseBlocks(content: string): Array<{
        operation: 'add' | 'update' | 'delete' | 'move';
        path: string;
        newPath?: string;
        content: string;
    }> {
        const blocks: Array<{
            operation: 'add' | 'update' | 'delete' | 'move';
            path: string;
            newPath?: string;
            content: string;
        }> = [];

        const lines = content.split('\n');
        let currentBlock: { operation: 'add' | 'update' | 'delete' | 'move'; path: string; newPath?: string; lines: string[] } | null = null;

        for (const line of lines) {
            const addMatch = line.match(/^\*\*\* Add File:\s*(.+)$/);
            const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)$/);
            const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)$/);
            const moveMatch = line.match(/^\*\*\* Move to:\s*(.+)$/);

            if (addMatch) {
                if (currentBlock) {
                    blocks.push({ ...currentBlock, content: currentBlock.lines.join('\n') });
                }
                currentBlock = { operation: 'add', path: addMatch[1].trim(), lines: [] };
            } else if (updateMatch) {
                if (currentBlock) {
                    blocks.push({ ...currentBlock, content: currentBlock.lines.join('\n') });
                }
                currentBlock = { operation: 'update', path: updateMatch[1].trim(), lines: [] };
            } else if (deleteMatch) {
                if (currentBlock) {
                    blocks.push({ ...currentBlock, content: currentBlock.lines.join('\n') });
                }
                blocks.push({ operation: 'delete', path: deleteMatch[1].trim(), content: '' });
                currentBlock = null;
            } else if (moveMatch && currentBlock && currentBlock.operation === 'update') {
                currentBlock.operation = 'move';
                currentBlock.newPath = moveMatch[1].trim();
            } else if (currentBlock) {
                currentBlock.lines.push(line);
            }
        }

        if (currentBlock) {
            blocks.push({ ...currentBlock, content: currentBlock.lines.join('\n') });
        }

        return blocks;
    }

    private async processBlock(
        block: { operation: 'add' | 'update' | 'delete' | 'move'; path: string; newPath?: string; content: string },
        basePath: string,
        dryRun: boolean,
        projectContext?: any
    ): Promise<PatchResult> {
        const resolvedBase = path.resolve(basePath);
        const resolveInsideBase = (candidate: string) => {
            let resolved = path.resolve(resolvedBase, candidate);
            // Phase 23 — when bound to a project, every patch target goes
            // through the canonical workspace boundary (blocks `..` escapes and
            // absolute paths outside the workspace with a structured violation).
            if (projectContext) {
                resolved = assertWorkspacePath(resolved, projectContext);
            }
            const relative = path.relative(resolvedBase, resolved);
            if (relative.startsWith('..') || path.isAbsolute(relative)) {
                throw new Error(`Patch path escapes the workspace: ${candidate}`);
            }
            return resolved;
        };
        const fullPath = resolveInsideBase(block.path);

        if (block.operation === 'add') {
            const addedLines = block.content
                .split('\n')
                .filter(line => line.startsWith('+'));
            const fileContent = addedLines.map(line => line.slice(1)).join('\n');

            if (!dryRun) {
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, fileContent);
            }
            return { operation: 'add', path: block.path, success: true, added: addedLines.length, removed: 0 };
        }

        if (block.operation === 'delete') {
            const removed = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, 'utf-8').split('\n').length : 0;
            if (!dryRun) {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            }
            return { operation: 'delete', path: block.path, success: true, added: 0, removed };
        }

        if (block.operation === 'update' || block.operation === 'move') {
            if (!fs.existsSync(fullPath)) {
                return { operation: block.operation, path: block.path, success: false, error: 'File not found' };
            }

            const existingContent = fs.readFileSync(fullPath, 'utf-8');
            const { content: newContent, added, removed } = this.applyHunks(existingContent, block.content);

            if (!dryRun) {
                if (block.operation === 'move' && block.newPath) {
                    const newFullPath = resolveInsideBase(block.newPath);
                    const newDir = path.dirname(newFullPath);
                    if (!fs.existsSync(newDir)) {
                        fs.mkdirSync(newDir, { recursive: true });
                    }
                    fs.writeFileSync(newFullPath, newContent);
                    fs.unlinkSync(fullPath);
                    return { operation: 'move', path: block.path, newPath: block.newPath, success: true, added, removed };
                } else {
                    fs.writeFileSync(fullPath, newContent);
                }
            }
            return { operation: block.operation, path: block.path, newPath: block.newPath, success: true, added, removed };
        }

        return { operation: block.operation, path: block.path, success: false, error: 'Unknown operation' };
    }

    private applyHunks(original: string, hunksContent: string): { content: string; added: number; removed: number } {
        let added = 0;
        let removed = 0;
        let lines = original.replace(/\r\n/g, '\n').split('\n');
        const rawLines = hunksContent.replace(/\r\n/g, '\n').split('\n');
        const hunks: string[][] = [];
        let current: string[] | null = null;

        for (const line of rawLines) {
            if (line.startsWith('@@')) {
                if (current) hunks.push(current);
                current = [];
                continue;
            }
            if (!current) continue;
            if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-')) {
                current.push(line);
            }
        }
        if (current) hunks.push(current);
        if (hunks.length === 0) {
            throw new Error('Update patch must include at least one @@ hunk.');
        }

        let searchFrom = 0;
        for (const hunk of hunks) {
            const oldLines = hunk
                .filter(line => !line.startsWith('+'))
                .map(line => line.slice(1));
            const newLines = hunk
                .filter(line => !line.startsWith('-'))
                .map(line => line.slice(1));
            added += hunk.filter(line => line.startsWith('+')).length;
            removed += hunk.filter(line => line.startsWith('-')).length;
            if (oldLines.length === 0) {
                throw new Error('Pure additions in an update hunk need at least one context line.');
            }

            const matchAt = (start: number) => oldLines.every((line, offset) => lines[start + offset] === line);
            let matchIndex = -1;
            for (let index = searchFrom; index <= lines.length - oldLines.length; index += 1) {
                if (matchAt(index)) {
                    matchIndex = index;
                    break;
                }
            }
            if (matchIndex < 0 && searchFrom > 0) {
                for (let index = 0; index < searchFrom; index += 1) {
                    if (matchAt(index)) {
                        matchIndex = index;
                        break;
                    }
                }
            }
            if (matchIndex < 0) {
                const preview = oldLines.slice(0, 4).join('\\n');
                throw new Error(`Patch context not found: ${preview}`);
            }

            lines.splice(matchIndex, oldLines.length, ...newLines);
            searchFrom = matchIndex + newLines.length;
        }

        return { content: lines.join('\n'), added, removed };
    }
}
