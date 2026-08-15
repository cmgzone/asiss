import { Skill } from '../core/skills';
import fs from 'fs';
import path from 'path';
import { resolveSkillPath, boundaryErrorResult } from './workspace-guard';

export class ReadFileSkill implements Skill {
  name = 'read_file';
  description = 'Read the contents of a file from disk and return its text. Supports an optional 1-based line range and optional maximum character limit. Paths resolve inside the active project workspace only.';
  capabilities = ['file_read'];
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read (absolute, or relative to the workspace root).' },
      startLine: { type: 'number', description: 'Optional 1-based line number to start reading from.' },
      endLine: { type: 'number', description: 'Optional 1-based line number to stop reading at (inclusive).' },
      maxChars: { type: 'number', description: 'Optional maximum number of characters to return.' }
    },
    required: ['path']
  };

  async execute(params: any): Promise<any> {
    let filePath: string;
    try {
      // Phase 23 — workspace boundary: relative paths resolve against the
      // active project workspace; absolute paths outside it are BLOCKED.
      filePath = resolveSkillPath(params?.path ?? params?.filePath ?? params?.file, params);
    } catch (error: any) {
      return boundaryErrorResult(error, 'read_file');
    }
    if (!filePath) return { error: 'Path is required.' };
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error: any) {
      return { error: `File not found: ${filePath} (${error?.message || error})` };
    }
    if (!stat.isFile()) return { error: `Not a file: ${filePath}` };
    if (stat.size > 50 * 1024 * 1024) {
      return { error: `File too large to read (${stat.size} bytes, limit 50 MB). Use shell tools instead.` };
    }
    try {
      let text = fs.readFileSync(filePath, 'utf-8');
      const totalLines = text.split('\n').length;
      const startLine = Math.max(1, Math.floor(Number(params?.startLine) || 1));
      const endLine = Math.min(totalLines, Math.floor(Number(params?.endLine) || totalLines));
      if (startLine > 1 || endLine < totalLines) {
        text = text.split('\n').slice(startLine - 1, endLine).join('\n');
      }
      const maxChars = Math.max(100, Math.floor(Number(params?.maxChars) || 0));
      if (maxChars > 0 && text.length > maxChars) {
        text = text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]`;
      }
      return { success: true, path: filePath, content: text, lineCount: totalLines, startLine, endLine };
    } catch (error: any) {
      return { error: `Failed to read ${filePath}: ${error?.message || error}` };
    }
  }
}

export class WriteFileSkill implements Skill {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing file with the provided content. Parent directories are created automatically. Set append=true to append to an existing file instead of overwriting. Paths resolve inside the active project workspace only.';
  capabilities = ['file_write'];
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write (absolute, or relative to the workspace root).' },
      content: { type: 'string', description: 'The full content to write to the file.' },
      append: { type: 'boolean', description: 'When true, append content to the file instead of overwriting it.' }
    },
    required: ['path', 'content']
  };

  async execute(params: any): Promise<any> {
    let filePath: string;
    try {
      // Phase 23 — writing outside the active workspace is a hard block.
      filePath = resolveSkillPath(params?.path ?? params?.filePath ?? params?.file, params);
    } catch (error: any) {
      return boundaryErrorResult(error, 'write_file');
    }
    const content = params?.content ?? params?.text ?? params?.data;
    if (!filePath) return { error: 'Path is required.' };
    if (typeof content !== 'string') return { error: 'Content must be a string.' };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const append = params?.append === true;
      if (append) fs.appendFileSync(filePath, content, 'utf-8');
      else fs.writeFileSync(filePath, content, 'utf-8');
      return {
        success: true,
        path: filePath,
        action: append ? 'appended' : 'written',
        bytes: Buffer.byteLength(content, 'utf-8'),
        lines: content.split('\n').length,
        size: fs.statSync(filePath).size
      };
    } catch (error: any) {
      return { error: `Failed to write ${filePath}: ${error?.message || error}` };
    }
  }
}

export class ListDirectorySkill implements Skill {
  name = 'list_directory';
  description = 'List the immediate files and directories inside a folder. Returns names and entry types, sorted directories-first. Paths resolve inside the active project workspace only.';
  capabilities = ['file_list'];
  inputSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the directory to list (absolute, or relative to the workspace root). Defaults to the workspace root.' }
    },
    required: []
  };

  async execute(params: any): Promise<any> {
    let dirPath: string;
    try {
      // Phase 23 — defaults to the workspace root when bound, never process.cwd().
      dirPath = resolveSkillPath(params?.path ?? params?.directory ?? params?.dir ?? '.', params);
    } catch (error: any) {
      return boundaryErrorResult(error, 'list_directory');
    }
    try {
      if (!fs.existsSync(dirPath)) return { error: `Directory not found: ${dirPath}` };
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) return { error: `Not a directory: ${dirPath}` };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : (entry.isSymbolicLink() ? 'symlink' : 'file')
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'directory' ? -1 : 1)));
      return { success: true, path: dirPath, entries, count: entries.length };
    } catch (error: any) {
      return { error: `Failed to list ${dirPath}: ${error?.message || error}` };
    }
  }
}

// Convert a glob pattern (with **, *, ?) into a regex matched against
// slash-separated relative paths.
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

export class GlobSkill implements Skill {
  name = 'glob';
  description = 'Find files and directories matching a glob pattern (e.g. "src/**/*.ts", "*.json"). Returns relative paths. node_modules and .git are skipped. Searches inside the active project workspace only.';
  capabilities = ['file_glob'];
  inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match, e.g. "src/**/*.ts".' },
      cwd: { type: 'string', description: 'Optional directory to search from (absolute or relative). Defaults to the workspace root.' }
    },
    required: ['pattern']
  };

  async execute(params: any): Promise<any> {
    const pattern = String(params?.pattern || '').trim();
    if (!pattern) return { error: 'Pattern is required.' };
    let cwd: string;
    try {
      // Phase 23 — globs stay inside the active workspace.
      cwd = resolveSkillPath(params?.cwd ?? params?.dir ?? '.', params);
    } catch (error: any) {
      return boundaryErrorResult(error, 'glob');
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { error: `Search directory not found: ${cwd}` };
    }
    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch (error: any) {
      return { error: `Invalid glob pattern: ${error?.message || error}` };
    }
    const matches: string[] = [];
    const maxResults = Math.min(1000, Math.max(10, Math.floor(Number(params?.maxResults) || 500)));

    const walk = (dir: string, base: string, depth: number): void => {
      if (depth > 16 || matches.length >= maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= maxResults) return;
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          if (re.test(rel)) matches.push(`${rel}/`);
          walk(path.join(dir, entry.name), rel, depth + 1);
        } else if (entry.isFile()) {
          if (re.test(rel)) matches.push(rel);
        }
      }
    };

    try {
      walk(cwd, '', 0);
    } catch (error: any) {
      return { error: `Glob search failed: ${error?.message || error}` };
    }
    matches.sort();
    return { success: true, pattern, cwd, matches, count: matches.length, truncated: matches.length >= maxResults };
  }
}
