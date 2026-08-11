import { Skill } from '../core/skills';
import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = util.promisify(execFile);

const DEFAULT_IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', 'artifacts', '.wwebjs_cache'
]);

export class CodeSearchSkill implements Skill {
  name = 'code_search';
  description = 'Search the codebase for a regex/string pattern and return matching file paths with line numbers and the matched lines. Use this (instead of the shell) for fast, structured code search across the project. Supports glob include/exclude and case sensitivity.';
  capabilities = ['code_search'];

  inputSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
      include: { type: 'string', description: 'Glob to filter files, e.g. "*.ts" (optional)' },
      exclude: { type: 'string', description: 'Glob to exclude files, e.g. "*.test.ts" (optional)' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default false)' },
      maxResults: { type: 'number', description: 'Max matches to return (default 50)' }
    },
    required: ['pattern']
  };

  async execute(params: any): Promise<any> {
    const pattern = typeof params?.pattern === 'string' ? params.pattern : '';
    if (!pattern) return { error: 'pattern is required' };
    const base = typeof params?.path === 'string' && params.path.trim()
      ? params.path.trim()
      : (typeof params?.__workspacePath === 'string' ? params.__workspacePath : process.cwd());
    const include = typeof params?.include === 'string' ? params.include.trim() : '';
    const exclude = typeof params?.exclude === 'string' ? params.exclude.trim() : '';
    const caseSensitive = params?.caseSensitive === true;
    const maxResults = Math.min(500, Math.max(1, typeof params?.maxResults === 'number' ? params.maxResults : 50));

    try {
      return await this.searchWithRipgrep(base, pattern, { include, exclude, caseSensitive, maxResults });
    } catch {
      return this.searchFallback(base, pattern, { include, exclude, caseSensitive, maxResults });
    }
  }

  private async searchWithRipgrep(base: string, pattern: string, opts: { include: string; exclude: string; caseSensitive: boolean; maxResults: number }) {
    const args = ['--line-number', '--with-filename', '--color', 'never', '--max-count', String(opts.maxResults)];
    if (!opts.caseSensitive) args.push('--ignore-case');
    args.push('--hidden');
    for (const d of DEFAULT_IGNORE_DIRS) args.push('--glob', `!**/${d}/**`, '--glob', `!**/${d}`);
    if (opts.include) args.push('--glob', opts.include);
    if (opts.exclude) args.push('--glob', `!${opts.exclude}`);
    args.push('--regexp', pattern, base);

    try {
      const { stdout, stderr } = await execFileAsync('rg', args, { cwd: base, windowsHide: true, maxBuffer: 20 * 1024 * 1024 } as any);
      const lines = String(stdout || '').split('\n').filter(Boolean).slice(0, opts.maxResults);
      return this.formatResults(lines, String(stderr));
    } catch (err: any) {
      // rg exits 1 when no matches; treat that as empty results, not an error.
      if (err?.code === 1) {
        return { pattern, path: base, count: 0, results: [], note: 'No matches found.' };
      }
      if (err?.code === 'ENOENT') {
        throw new Error('ripgrep not installed');
      }
      const lines = String(err?.stdout || '').split('\n').filter(Boolean);
      if (lines.length) return this.formatResults(lines, String(err?.stderr || ''));
      throw err;
    }
  }

  private searchFallback(base: string, pattern: string, opts: { include: string; exclude: string; caseSensitive: boolean; maxResults: number }) {
    const regex = new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi');
    const includeRe = opts.include ? this.globToRegExp(opts.include) : null;
    const excludeRe = opts.exclude ? this.globToRegExp(opts.exclude) : null;
    const results: Array<{ file: string; line: number; text: string }> = [];

    const walk = (dir: string) => {
      if (results.length >= opts.maxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= opts.maxResults) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(base, full).replace(/\\/g, '/');
          if (includeRe && !includeRe.test(rel)) continue;
          if (excludeRe && excludeRe.test(rel)) continue;
          let content: string;
          try {
            const stat = fs.statSync(full);
            if (stat.size > 2 * 1024 * 1024) continue;
            content = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= opts.maxResults) break;
            if (regex.test(lines[i])) {
              results.push({ file: rel, line: i + 1, text: lines[i].trim() });
            }
          }
        }
      }
    };

    walk(base);
    return {
      pattern,
      path: base,
      count: results.length,
      engine: 'builtin-fallback',
      results
    };
  }

  private formatResults(lines: string[], stderr?: string) {
    const results = lines.map((line) => {
      const idx = line.indexOf(':');
      const file = line.slice(0, idx);
      const rest = line.slice(idx + 1);
      const lidx = rest.indexOf(':');
      const lineNo = Number(rest.slice(0, lidx)) || 0;
      const text = rest.slice(lidx + 1).trim();
      return { file, line: lineNo, text };
    });
    return {
      pattern: '',
      path: '',
      count: results.length,
      engine: 'ripgrep',
      results,
      ...(stderr && String(stderr).trim() ? { warning: String(stderr).trim() } : {})
    };
  }

  private globToRegExp(glob: string): RegExp {
    const escaped = glob
      .replace(/[.+^${}()|]/g, '\\$&')
      .replace(/\*\*/g, '§')
      .replace(/\*/g, '[^/]*')
      .replace(/§/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`(^|/)${escaped}$`);
  }
}
