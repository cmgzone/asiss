import { Skill } from '../core/skills';
import fs from 'fs';
import path from 'path';

interface PatchResult {
    operation: 'add' | 'update' | 'delete' | 'move';
    path: string;
    newPath?: string;
    success: boolean;
    error?: string;
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
        const basePath = String(params?.basePath || process.cwd());
        const dryRun = Boolean(params?.dryRun);

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
                const result = await this.processBlock(block, basePath, dryRun);
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
        dryRun: boolean
    ): Promise<PatchResult> {
        const fullPath = path.resolve(basePath, block.path);

        if (block.operation === 'add') {
            const fileContent = block.content
                .split('\n')
                .filter(line => line.startsWith('+'))
                .map(line => line.slice(1))
                .join('\n');

            if (!dryRun) {
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(fullPath, fileContent);
            }
            return { operation: 'add', path: block.path, success: true };
        }

        if (block.operation === 'delete') {
            if (!dryRun) {
                if (fs.existsSync(fullPath)) {
                    fs.unlinkSync(fullPath);
                }
            }
            return { operation: 'delete', path: block.path, success: true };
        }

        if (block.operation === 'update' || block.operation === 'move') {
            if (!fs.existsSync(fullPath)) {
                return { operation: block.operation, path: block.path, success: false, error: 'File not found' };
            }

            const existingContent = fs.readFileSync(fullPath, 'utf-8');
            const newContent = this.applyHunks(existingContent, block.content);

            if (!dryRun) {
                if (block.operation === 'move' && block.newPath) {
                    const newFullPath = path.resolve(basePath, block.newPath);
                    const newDir = path.dirname(newFullPath);
                    if (!fs.existsSync(newDir)) {
                        fs.mkdirSync(newDir, { recursive: true });
                    }
                    fs.writeFileSync(newFullPath, newContent);
                    fs.unlinkSync(fullPath);
                    return { operation: 'move', path: block.path, newPath: block.newPath, success: true };
                } else {
                    fs.writeFileSync(fullPath, newContent);
                }
            }
            return { operation: block.operation, path: block.path, newPath: block.newPath, success: true };
        }

        return { operation: block.operation, path: block.path, success: false, error: 'Unknown operation' };
    }

    private applyHunks(original: string, hunksContent: string): string {
        const lines = original.split('\n');
        const hunkBlocks = hunksContent.split('@@').filter(h => h.trim());

        for (const hunkBlock of hunkBlocks) {
            const hunkLines = hunkBlock.split('\n').filter(l => l.startsWith('-') || l.startsWith('+') || l.trim() === '');

            const removals: string[] = [];
            const additions: string[] = [];

            for (const hunkLine of hunkLines) {
                if (hunkLine.startsWith('-')) {
                    removals.push(hunkLine.slice(1));
                } else if (hunkLine.startsWith('+')) {
                    additions.push(hunkLine.slice(1));
                }
            }

            // Find and replace the first occurrence
            if (removals.length > 0) {
                const removalPattern = removals.join('\n');
                const originalJoined = lines.join('\n');
                const idx = originalJoined.indexOf(removalPattern);
                if (idx !== -1) {
                    const before = originalJoined.slice(0, idx);
                    const after = originalJoined.slice(idx + removalPattern.length);
                    const replaced = before + additions.join('\n') + after;
                    lines.length = 0;
                    lines.push(...replaced.split('\n'));
                }
            } else if (additions.length > 0) {
                // Pure addition at end
                lines.push(...additions);
            }
        }

        return lines.join('\n');
    }
}
