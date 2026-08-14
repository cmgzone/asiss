import fs from 'fs';
import path from 'path';

/**
 * Phase 22 — resilient atomic JSON persistence.
 *
 * The previous pattern (write `.tmp` then `fs.renameSync` over the target)
 * throws EPERM on Windows when the destination file has an open handle —
 * which happens constantly under OneDrive sync (this workspace keeps its
 * `Gitu Data` under `C:\Users\Admin\OneDrive\`). A transient lock during a
 * mission's state save then bubbled up and ABORTED the whole mission.
 *
 * This helper makes persistence best-effort and non-fatal:
 *   1. write to `<file>.tmp`
 *   2. retry the atomic rename a few times with a short backoff (the lock is
 *      usually released within tens of ms)
 *   3. if the rename keeps failing, fall back to `copyFileSync` + unlink tmp
 *      (works even when the target is momentarily open for read)
 *   4. if even the fallback fails, keep the tmp file and schedule one deferred
 *      retry; NEVER throw — the in-memory store is authoritative and a later
 *      save will complete the write once the lock clears.
 */
export function atomicWriteJsonSync(filePath: string, data: unknown): void {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  fs.writeFileSync(temp, payload);

  const renameAttempts = 4;
  for (let attempt = 0; attempt < renameAttempts; attempt++) {
    try {
      fs.renameSync(temp, filePath);
      return;
    } catch (error: any) {
      const code = String(error?.code || '');
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt === renameAttempts - 1) {
        if (attempt === renameAttempts - 1) break;
        continue;
      }
      // Backoff: 20ms -> 40ms -> 80ms — long enough for a sync-engine
      // handle to release, short enough to not stall a mission.
      const waited = sleepSync(20 * Math.pow(2, attempt));
      if (!waited) break;
    }
  }

  // Rename still failing (persistent lock): fall back to copy + unlink.
  try {
    fs.copyFileSync(temp, filePath);
    try { fs.unlinkSync(temp); } catch { /* tmp cleanup is best-effort */ }
    return;
  } catch (error: any) {
    // Even the copy failed (target held for write). Keep the tmp file for a
    // deferred retry and log once. Persistence is best-effort — a transient
    // file lock must NEVER abort the running mission.
    try {
      scheduleDeferredRetry(filePath);
    } catch { /* scheduling is best-effort */ }
    console.warn(
      `[atomic-write] could not persist ${path.basename(filePath)} ` +
      `(${error?.message || error}); kept ${path.basename(temp)} — will retry on the next save.`
    );
  }
}

// One pending deferred retry per file path (keyed in a module-level Set) so a
// burst of failures does not pile up timers.
const deferredRetry = new Set<string>();

function scheduleDeferredRetry(filePath: string): void {
  if (deferredRetry.has(filePath)) return;
  deferredRetry.add(filePath);
  setTimeout(() => {
    deferredRetry.delete(filePath);
    if (!fs.existsSync(`${filePath}.tmp`)) return;
    try {
      fs.renameSync(`${filePath}.tmp`, filePath);
    } catch {
      try {
        fs.copyFileSync(`${filePath}.tmp`, filePath);
        try { fs.unlinkSync(`${filePath}.tmp`); } catch { /* best-effort */ }
      } catch { /* next save will try again */ }
    }
  }, 500);
}

// Synchronous delay: this helper's API is sync (it must fit the existing
// save() call sites), so a short busy-wait is the only option. The window is
// tens of ms total and only happens on a transient lock.
function sleepSync(ms: number): boolean {
  if (!ms || ms <= 0) return false;
  const start = Date.now();
  while (Date.now() - start < ms) { /* spin */ }
  return true;
}
