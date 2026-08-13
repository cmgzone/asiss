/**
 * Architecture discovery — Hermes Evolution Phase 18 Move 5.
 *
 * A bounded, convention-based pass over the persistent repository index:
 * entry points, services/APIs, workers/queues, databases, test
 * infrastructure, integrations, and configuration surfaces — classified
 * from file paths/names, the index's isTest/isConfig flags, and symbol
 * exports. Deliberately heuristic like the rest of the index ("not a
 * compiler"): it classifies likely roles, it does not prove them. No new
 * index authority, no content reads — everything comes from the index.
 */

import path from 'path';
import type { IndexedFileDetail, PersistentRepositoryIndex } from './repo-index';

export type ArchitectureKind = 'entry' | 'service' | 'worker' | 'database' | 'integration' | 'test' | 'config';

export interface ArchitectureFile {
  path: string;
  kind: ArchitectureKind;
  isTest: boolean;
  isConfig: boolean;
  /** Symbols the file exports (entry points / API surfaces). */
  exports: string[];
}

export interface ArchitectureProfile {
  root: string;
  fileCount: number;
  languages: Record<string, number>;
  entryPoints: ArchitectureFile[];
  services: ArchitectureFile[];
  workers: ArchitectureFile[];
  databases: ArchitectureFile[];
  integrations: ArchitectureFile[];
  testFiles: ArchitectureFile[];
  testConfigs: ArchitectureFile[];
  configFiles: ArchitectureFile[];
  indexedAt: number;
}

export interface ArchitectureRenderOptions {
  /** Cap files listed per bucket. Default 8. */
  maxPerBucket?: number;
}

/** Root-level entry-point basenames (index only counts at shallow depth). */
const ENTRY_BASENAMES = new Set(['main', 'server', 'app', 'start', 'bootstrap', 'run', 'cli']);
const WORKER_TOKENS = ['worker', 'queue', 'job', 'cron', 'scheduler', 'daemon', 'listener'];
const SERVICE_TOKENS = ['api', 'route', 'controller', 'handler', 'endpoint', 'service', 'graphql', 'rest', 'view'];
const DB_TOKENS = ['db', 'database', 'schema', 'migration', 'repository', 'repositories', 'entity', 'entities', 'sql', 'query'];
const INTEGRATION_TOKENS = ['integration', 'connector', 'adapter', 'webhook', 'provider', 'plugin', 'sdk', 'client'];
const TEST_CONFIG_RE = /(jest|vitest|mocha|cypress|playwright|karma|pytest)[.\w-]*\.(js|ts|cjs|mjs|json|ini|conf|config)?$/i;

/** Convention-based role classification for one indexed file. */
export function classifyArchitecture(file: IndexedFileDetail): ArchitectureKind[] {
  const kinds: ArchitectureKind[] = [];
  const lower = file.path.toLowerCase();
  const parts = lower.split(/[./_ -]+/).filter(Boolean);
  const stem = path.posix.basename(lower).replace(/\.[^.]+$/, '');
  const depth = lower.split('/').length;
  if (ENTRY_BASENAMES.has(stem) || (stem === 'index' && depth <= 2)) kinds.push('entry');
  if (parts.some((p) => WORKER_TOKENS.includes(p))) kinds.push('worker');
  if (parts.some((p) => SERVICE_TOKENS.includes(p))) kinds.push('service');
  if (parts.some((p) => DB_TOKENS.includes(p))) kinds.push('database');
  if (parts.some((p) => INTEGRATION_TOKENS.includes(p))) kinds.push('integration');
  if (file.isTest) kinds.push('test');
  if (file.isConfig) kinds.push('config');
  return kinds;
}

function toArchitectureFile(file: IndexedFileDetail, kind: ArchitectureKind): ArchitectureFile {
  return {
    path: file.path,
    kind,
    isTest: file.isTest,
    isConfig: file.isConfig,
    exports: file.symbols.map((s) => s.name).slice(0, 16)
  };
}

/** Discover the architecture buckets for a persistent index. */
export function discoverArchitecture(index: PersistentRepositoryIndex): ArchitectureProfile {
  const buckets: Record<ArchitectureKind, ArchitectureFile[]> = {
    entry: [], service: [], worker: [], database: [], integration: [], test: [], config: []
  };
  for (const file of index.files) {
    for (const kind of classifyArchitecture(file)) {
      buckets[kind].push(toArchitectureFile(file, kind));
    }
  }
  for (const list of Object.values(buckets)) list.sort((a, b) => a.path.localeCompare(b.path));
  return {
    root: index.root,
    fileCount: index.fileCount,
    languages: index.languages,
    entryPoints: buckets.entry,
    services: buckets.service,
    workers: buckets.worker,
    databases: buckets.database,
    integrations: buckets.integration,
    testFiles: buckets.test,
    testConfigs: buckets.config.filter((f) => TEST_CONFIG_RE.test(f.path)),
    configFiles: buckets.config,
    indexedAt: index.indexedAt
  };
}

/** Human-readable architecture overview (renders into the skill/section). */
export function renderArchitectureProfile(profile: ArchitectureProfile, options: ArchitectureRenderOptions = {}): string {
  const max = options.maxPerBucket ?? 8;
  const lines: string[] = ['Architecture overview:'];
  lines.push(`- ${profile.fileCount} files, indexed ${new Date(profile.indexedAt).toISOString()}`);
  const topLangs = Object.entries(profile.languages)
    .filter(([ext]) => ext !== '')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([ext, n]) => `${ext.slice(1) || 'text'} (${n})`)
    .join(', ');
  if (topLangs) lines.push(`- Languages: ${topLangs}`);

  const bucket = (label: string, files: ArchitectureFile[]): void => {
    if (files.length === 0) return;
    const shown = files.slice(0, max);
    lines.push(`- ${label} (${files.length}):`);
    for (const f of shown) {
      const exportsNote = f.kind === 'entry' || f.kind === 'service'
        ? (f.exports.length ? ` — exports ${f.exports.slice(0, 6).join(', ')}` : '')
        : '';
      lines.push(`  - ${f.path}${exportsNote}`);
    }
    if (files.length > max) lines.push(`  … and ${files.length - max} more`);
  };

  bucket('Entry points', profile.entryPoints);
  bucket('Services / APIs', profile.services);
  bucket('Workers / queues', profile.workers);
  bucket('Databases', profile.databases);
  bucket('Integrations', profile.integrations);
  bucket('Test files', profile.testFiles);
  bucket('Test config', profile.testConfigs);
  bucket('Config files', profile.configFiles);
  return lines.join('\n');
}
