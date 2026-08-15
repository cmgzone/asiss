/**
 * Repository context — Hermes Evolution Phase 7.
 *
 * Lightweight, dependency-free repository intelligence for coding tasks.
 * Instead of dumping the whole tree into the prompt, build a small index
 * (paths, sizes, languages) and surface the files most relevant to the goal:
 *
 *   "Fix authentication"  ->  src/auth/*, middleware/auth.ts, tests/auth/*
 *
 * The index is refreshed per build (no persistent watcher yet — that is the
 * Phase 8 depth). Path scoring uses keyword overlap on path segments plus a
 * locality bonus for files under directories matching the goal tokens.
 */

import fs from 'fs';
import path from 'path';
import { relevanceScore } from './relevance';

/** Directories never worth indexing (common noise). */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next',
  '.nuxt', '.venv', 'venv', '__pycache__', '.cache', 'target', 'bin', 'obj',
  '.idea', '.vscode', 'logs', 'tmp', '.pytest_cache', '.mypy_cache'
]);

const IGNORED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.woff', '.woff2',
  '.ttf', '.eot', '.pdf', '.zip', '.gz', '.tar', '.lock', '.sqlite', '.db',
  '.min.js', '.map'
]);

export interface IndexedFile {
  path: string;         // relative to the repository root, forward slashes
  name: string;
  size: number;
  extension: string;
  tokens: string[];     // path segments + name, lowercase
}

export interface RepositoryIndex {
  root: string;
  /** Phase 23 §7 — project attribution; the index may only be served to the
   *  project that owns it (requested projectId MUST match index.projectId). */
  projectId?: string;
  files: IndexedFile[];
  fileCount: number;
  totalBytes: number;
  languages: Record<string, number>; // extension -> file count
  indexedAt: number;
}

export interface RepositoryContextOptions {
  /** Max files to include in the index. Default 2000 (bounded memory). */
  maxFiles?: number;
  /** Max depth below root. Default 12. */
  maxDepth?: number;
}

function extOf(file: string): string {
  const base = path.basename(file).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
}

/** Walk the repository and index files (bounded, excludes noise). */
export function indexWorkspace(root: string, options: RepositoryContextOptions = {}): RepositoryIndex {
  const maxFiles = options.maxFiles ?? 2000;
  const maxDepth = options.maxDepth ?? 12;
  const files: IndexedFile[] = [];
  let totalBytes = 0;

  const walk = (dir: string, depth: number): void => {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir (permissions, broken symlink) -> skip
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? 1 : -1));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extOf(entry.name);
      if (IGNORED_EXT.has(ext)) continue;
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      totalBytes += size;
      const rel = path.relative(root, full).split(path.sep).join('/');
      const tokens = rel.toLowerCase().split(/[/._-]+/).filter(Boolean);
      files.push({ path: rel, name: entry.name, size, extension: ext, tokens });
    }
  };

  walk(root, 0);

  const languages: Record<string, number> = {};
  for (const file of files) {
    languages[file.extension] = (languages[file.extension] || 0) + 1;
  }
  return { root, files, fileCount: files.length, totalBytes, languages, indexedAt: Date.now() };
}

/** Score how relevant an indexed file is to the goal (0-1). */
export function fileRelevance(file: IndexedFile, goal: string): number {
  if (!goal) return 0;
  // Path + name overlap, plus a small bonus for depth (more specific paths win).
  const overlap = relevanceScore(goal, file.path);
  const depthBonus = Math.min(0.1, file.path.split('/').length * 0.02);
  return Math.min(1, overlap + depthBonus);
}

/** Top-N most relevant files for the goal. */
export function matchFiles(index: RepositoryIndex, goal: string, limit = 12): IndexedFile[] {
  if (!goal) return index.files.slice(0, limit);
  return [...index.files]
    .map((file) => ({ file, score: fileRelevance(file, goal) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.file);
}

export interface RepositoryRenderOptions {
  /** Relevant files to highlight. Defaults to matchFiles(index, goal). */
  relevantFiles?: IndexedFile[];
  /** Cap the full-file list rendered. Default 40. */
  maxListed?: number;
  /** Include languages breakdown. Default true. */
  includeLanguages?: boolean;
}

/** Render a repository context block for the system prompt. */
export function renderRepositoryContext(
  index: RepositoryIndex,
  goal: string,
  options: RepositoryRenderOptions = {}
): string {
  const relevant = options.relevantFiles || matchFiles(index, goal);
  const maxListed = options.maxListed ?? 40;
  const lines: string[] = [];
  lines.push('Repository context:');
  lines.push(`- Root: ${index.root}`);
  lines.push(`- ${index.fileCount} files, ${(index.totalBytes / 1024).toFixed(0)} KB`);
  if (options.includeLanguages !== false) {
    const topLangs = Object.entries(index.languages)
      .filter(([ext]) => ext !== '')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([ext, count]) => `${ext.slice(1) || 'text'} (${count})`)
      .join(', ');
    if (topLangs) lines.push(`- Languages: ${topLangs}`);
  }
  if (relevant.length > 0) {
    lines.push('Files most relevant to the current goal:');
    for (const file of relevant.slice(0, maxListed)) {
      lines.push(`- ${file.path}`);
    }
  }
  return lines.join('\n');
}
