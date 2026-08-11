# Hermes Evolution — Phase 0 Baseline (Known-Good)

> **Status: ✅ Recorded** — this is the reference point for the controlled
> architectural evolution. Nothing here has been modified by the evolution work;
> it freezes what the system is before Phase 1 begins.

## Git state

| Item | Value |
| --- | --- |
| Branch | `main` |
| Baseline commit | `6bb7672` — "Add model capability levels and dynamic model routing" |
| Working tree | Dirty — runtime data files only (see below), no source edits |
| Last commits | `6bb7672`, `b752172`, `52fa4f1`, `3bc1bf6`, `dcd4408`, `ec681fc` |

Working-tree modifications at baseline (runtime data, not source):
`MEMORY.md`, `memory.sqlite`, `notes.md`, `projects_data.json`, `users.json`,
`logs/*` (memory/notes/project state written by the running agent).

## Build / typecheck status

| Check | Command | Result |
| --- | --- | --- |
| Typecheck (no emit) | `npx tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Build | `npm run build` (tsc → dist + runtime assets) | Not run at baseline; `tsc --noEmit` is the gate used here |
| Unit tests | `npm test` | ⚠️ Stub — `echo "Error: no test specified"` |
| Smoke tests | `npm run smoke:*` (scripts/smoke-*.ts) | ✅ Green individually; runnable offline with temp dirs |

Note: `tsconfig.json` targets `es2018` / CommonJS, `strict: true`, and compiles
`src/**/*` only (`scripts/` runs via `ts-node` and is not part of the build).

## Verification instructions

```bash
# The single gate used for this evolution: clean typecheck
npx tsc --noEmit -p tsconfig.json

# Offline smoke tests (no model API needed)
npm run smoke:checkpoints
npm run smoke:baseline   # added in Phase 0/1
```

## Deliverable definition

Hermes v-current at `6bb7672` with a clean `tsc --noEmit` is the known-good
baseline. **Do not move code until this baseline works.** All Phase 1+ work
must keep `tsc --noEmit` green and leave `src/agents/runner.ts` (AgentRunner)
functionally untouched.

## Phase tracking

See [`ROADMAP.md`](./ROADMAP.md) for the per-phase status.
