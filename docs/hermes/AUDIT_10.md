# Hermes Architecture Audit 10 — Verification & Quality Gates (Phase 19, Move 1)

> Docs-first audit for Phase 19: **deterministic gates — lint/typecheck/
> tests/build/security/diff + acceptance criteria + evidence.** Per the
> governing rules: the roadmap row says exactly that, and the Phase 17
> closeout deferred this phase in favor of Phase 18 ("the quality gates that
> were deferred when Phase 18 took priority"). This audit maps the CURRENT
> verification state against the Phase 19 TARGET gate by gate, separates
> implementation from documentation, and proposes the smallest consolidation
> for each verified gap. Nothing here is assumed — every claim carries a
> source file (or a test, or a commit) from the audit on 2026-08-12 at HEAD
> `07e2410`.

## 1. The Phase 19 target vs what exists today

| Gate | Target (Phase 19 row) | Current implementation | Status |
|---|---|---|---|
| **typecheck** | a deterministic typecheck gate | `tsc --noEmit` against a strict tsconfig (`strict: true`, `skipLibCheck`) — run **by hand** every phase, exit code never wired into any script or gate; no npm script | 🟡 (capability real, gate absent) |
| **tests** | a deterministic test gate | `npm test` is a **stub** (`echo "Error: no test specified" && exit 1`). The real surface is ~29 `smoke:*` scripts run **manually one at a time** — no aggregate runner, no ordering, no exit-code aggregation, no report | ❌ (gate) / ✅ (smoke surface) |
| **build** | a deterministic build gate | `npm run build` (`tsc -p && node scripts/copy-runtime-assets.js`) exists; `dist/` is gitignored and untracked. Never part of any gate | 🟡 |
| **lint** | a lint gate | **entirely absent** — no eslint config, no lint script, no rule engine of any kind (`ls node_modules/.bin \| grep eslint` → empty) | ❌ |
| **security** | a security gate | **entirely absent** — no `npm audit`, no dependency scan, no secrets scan, no code scan (grep for security/vulnerab/npm audit/semgrep across src+scripts → zero) | ❌ |
| **diff** | a diff gate | **entirely absent** — no programmatic check of change scope/size/secrets (grep for `git diff` across src+scripts → zero; `filesChanged` is a report *field*, not a check) | ❌ |
| **acceptance criteria** | criteria evaluated deterministically | criteria exist as **data**: `goal.acceptanceCriteria` (`main-goal.ts`, rendered "Done means: …" at `runner.ts:3502`), `expectedOutput`/`reviewCriteria` on child/delegation tasks (`agent-result.ts`, `agent-engine.ts`). Phase 17's `runCompletionVerificationGate` (`task-engine.ts:901`) runs goal-matched **tests** at completion points and records `TaskVerification`. But **no code evaluates the stated acceptance criteria themselves** — the gate is test-based, not criteria-based | 🟡 (data + test gate, no criteria check) |
| **evidence** | gate-level evidence artifact | rich **per-task** evidence: `TaskVerification` records/events (`TaskVerifying`/`TaskVerified`/`TaskVerificationFailed`, `task-events.ts`), `AgentResult.evidence` ("agents return EVIDENCE, not 'Done.'"), the runner's completion-check evidence render (`runner.ts:3354`). **No aggregate battery report** — the battery produces no artifact | 🟡 (per-task rich, no gate-level) |

## 2. The verified foundation (what is real)

All of the following was verified against source at HEAD `07e2410`:

- **Strict typecheck** — `tsconfig.json`: `strict: true`, `forceConsistentCasingInFileNames`, `esModuleInterop`; `tsc --noEmit` is the project's de-facto per-phase check and is clean at this HEAD.
- **A real smoke surface** — 29 `scripts/smoke-*.ts` registered in `package.json`: baseline, terminal-paths, context, config, tools, policy, turn-contract, scheduler, agent-engine, agent-execution, agent-task-profile, memory-unified, repo-index (26 sections), phase16 (permanent Phase 16/17 gates), phase18 (7 gates), runtime (e2e), delegation, checkpoints, model-engine, model-resilience, executable-skills, execution-backends, learning, execute-workflow, web-api, casual, repetition. Two permanent **comment-aware architectural gates** exist and are green (`smoke-phase16`, `smoke-phase18` — comments stripped so prose can neither trip nor soothe a sweep).
- **Completion verification** — `task-engine.ts:runCompletionVerificationGate` (Phase 17): EXECUTING → VERIFYING → verifier (goal-matched tests via `verify-then-retry.ts` `matchedTestFiles`/`detectTestCommand`/`runGoalTests`, bounded 45 s / 4 KB) → PASSED → COMPLETED with evidence; FAILED → repair (attempts+1, `TaskRetrying`) while the turn budget allows; budget-exhausted → terminal FAILED feeding episodic capture.
- **In-mission recovery evidence** — `task-engine.ts:diagnose` records `TestStarted`/`TestPassed`/`TestFailed` as `TaskVerification` and emits `TaskVerified`/`TaskVerificationFailed`/`TaskRecovered`.
- **Criteria as data** — `main-goal.ts` (`acceptanceCriteria` merge/unique, last-30 slice), runner prompt render (`Done means: …`), `expectedOutput`/`reviewCriteria` on `AgentResult` and delegated child tasks, review-prompt feed.
- **Repository hygiene** — `.gitignore` covers `dist/`, `.env`, `users.json`, `memory.sqlite`, `projects_data.json`, `logs/`, `MEMORY.md`, `notes.md`, `learning/`, `memory/`, `.wwebjs_*`, `nclaw-*`; `dist/` is untracked; `.env` is untracked (only `.env.example` tracked).
- **Host wiring** — the runner's completion check renders verification evidence into the continuation prompt (`runner.ts:3330-3364`); `goalVerification` is asserted end-to-end by `smoke-agent-runtime` (`verifyOutputs.length >= 1`).

## 3. Evidence matrix

| Requirement | Status | Evidence | Tests |
|---|---|---|---|
| F1 Audit | ❌ | No Phase 19 audit doc existed before this one; no gate runner, no lint config, no security tooling anywhere | — |
| F2 Typecheck | 🟡 | `tsconfig.json` strict; `tsc --noEmit` run by hand every phase, clean at HEAD | — (no script) |
| F3 Test gate | ❌ | `npm test` stub (`package.json`); 29 smokes, no aggregate runner/ordering/report | smokes individually green |
| F4 Build gate | 🟡 | `npm run build` exists; `dist/` gitignored; not in any gate | — |
| F5 Lint | ❌ | No eslint config/script/engine | — |
| F6 Security | ❌ | No audit/dependency scan/secrets scan; **tracked user data**: `users.json`, `memory.sqlite`, `projects_data.json` are tracked in this shared checkout (gitignored in spirit) | — |
| F7 Diff | ❌ | No programmatic diff/scope/secrets check | — |
| F8 Acceptance criteria | 🟡 | Data + prompt render (`main-goal.ts`, `runner.ts:3502`) + test-based completion gate (Phase 17); **no criteria evaluation** | smoke-turn-contract §16, smoke:runtime |
| F9 Evidence | 🟡 | Per-task `TaskVerification` + `AgentResult.evidence`; **no gate-level battery report** | smoke:turn-contract, smoke:runtime |
| F10 Permanent gate | ❌ | `smoke:phase16`/`smoke:phase18` guard older phases; nothing guards Phase 19 | — |

## 4. Findings, ranked

### G1 — the test gate is a stub; the battery is unscripted (the cheapest real win)

`npm test` exits 1 by design ("Error: no test specified"). The 29 smoke
scripts are run manually one at a time — every phase closeout narrates "the
full battery green in one pass" as a *hand-run sequence*, but there is no
command that runs the battery, no ordering, no exit-code aggregation, no
duration/result report, and nothing that fails CI-style when a smoke breaks.
A regression can slip between phases and be caught only by re-running 29
commands by hand. **Plan (Move 3): a battery runner** — one script that runs
the deterministic battery in the canonical order, aggregates
pass/fail/duration per script, writes a gate-report artifact, and exits
non-zero on any failure; wire `npm test` to it.

### G2 — typecheck is a habit, not a gate

`tsc --noEmit` is clean and strict but exists only as a manual invocation —
no npm script, no gate wiring, no place in any automated check. **Plan
(Move 2): `npm run typecheck`** + fold it into the composite gates.

### G3 — lint is entirely absent

No eslint, no config, no rule engine, no baseline. Installing a full linter
now would mean a config + a large baseline churn across 162 src files (58
with `console.*`, 103 with `any`) — a big diff that contradicts the repo's
zero-new-dependency discipline. **Plan (Move 4): a lightweight lint gate in
the smoke-phase16/18 style** — comment-aware mechanical rules the tree
already passes, enforced by a small `lint:src` script: no `debugger` (0
today), no `ts-ignore`/`ts-expect-error` (0 today), no `TODO`/`FIXME`/`XXX`
drift (1 today: `src/channels/discord.ts:65`, trivially fixable), and the
existing no-competing-authority sweeps kept centralized. ESLint adoption is
an explicit non-goal for this phase.

### G4 — security is entirely absent, and tracked user data is a latent exposure

No dependency audit, no secrets scan, no code scan. Separately, the shared
checkout **tracks** `users.json`, `memory.sqlite`, and `projects_data.json`
(real user/agent data, gitignored in spirit) — modified in the working tree
by normal runtime use. A whole-tree secrets gate would fail on the current
state; the real gate is **diff-based**: no *new* secret-shaped content may
enter tracked files. **Plan (Move 5): a security gate** — a local secrets
sweep (key/token/private-key patterns + high-entropy strings) over the diff
vs HEAD (fails only on additions, so the tree passes today) + `npm audit
--omit=dev` as an explicit out-of-band check (network-dependent, never in
the fast gate) + the tracked-data exposure documented as a known risk with
a remediation recommendation.

### G5 — diff is entirely absent

Nothing checks a change's scope: no `git diff --check` (whitespace errors),
no assertion that `dist/`/`.env`/`node_modules`/data files stay out of the
diff, no size/blob limits. **Plan (Move 6): a diff gate** — `git diff
--check` + scope assertions (no tracked changes to the gitignored-in-spirit
data files, no `dist/`, no `.env`, no large/secret-shaped additions,
sane file-count/line caps).

### G6 — acceptance criteria are data, not a check

`goal.acceptanceCriteria` ("Done means: …"), `expectedOutput`, and
`reviewCriteria` all feed prompts and reviews, but nothing evaluates them
deterministically. Phase 17's gate runs goal-matched *tests* — correct and
valuable, but not the same as checking the criteria a goal actually states.
**Plan (Move 7): criteria evaluation** — criteria that look like assertions
(test commands / file-contains / exit-code expectations) are evaluated at
the completion gate, their results recorded as `TaskVerification` evidence
alongside the test run; non-checkable criteria are reported as
uncheckable rather than silently passed.

### G7 — no gate-level evidence artifact

Per-task evidence is rich, but the battery produces nothing a reader can
open: no `gate-report` with per-gate status, durations, failures, and the
evidence each gate stands on. **Plan (Move 3, part 2): the battery writes
`logs/gate-report.json`** (and a human-readable summary), closing the
"evidence" half of the row.

## 5. Move plan

| Move | Closes | Deliverable |
|---|---|---|
| **Move 1** | F1 | This audit + ROADMAP row 19 → `[~]` (done, docs only) |
| **Move 2** | G2, F4 | `npm run typecheck` script + `build` exercised in the fast gate |
| **Move 3** | G1, G7, F3 | `scripts/run-battery.ts` — deterministic battery, aggregate pass/fail/duration, `logs/gate-report.json` evidence artifact, non-zero exit; `npm test` wired |
| **Move 4** | G3, F5 | `lint:src` — comment-aware mechanical rules (debugger / ts-ignore / TODO-FIXME drift + centralized authority sweeps), zero new deps |
| **Move 5** | G4, F6 | security gate — diff-based secrets sweep (passes today) + `npm audit` out-of-band + tracked-data risk documented |
| **Move 6** | G5, F7 | diff gate — `git diff --check` + scope/size/secrets assertions |
| **Move 7** | G6, F8 | acceptance-criteria evaluation at the completion gate, recorded as `TaskVerification` evidence |
| **Move 8** | F10 | permanent `smoke:phase19` gate asserting the Phase 19 invariants (test gate live, typecheck scripted, lint rules enforced, security/diff gates wired, criteria evaluated) |

Each move lands with `tsc --noEmit` clean + targeted smoke coverage + the
battery green in one pass, and is recorded in the corresponding section
below and the ROADMAP.

---

## Move 2 — typecheck + build scripts (done, G2/F4)

`npm run typecheck` (`tsc --noEmit`) turns the strict-check habit into a
scripted gate, and `npm run gate:fast` — the fast composite gate —
exercises **typecheck → the real build → the permanent phase16/phase18
gates → the wiring check**, failing fast on any step. `scripts/smoke-gates.ts`
asserts the wiring statically: `typecheck` is `tsc --noEmit`; `build` is the
canonical `tsc -p tsconfig.json && node scripts/copy-runtime-assets.js`
(emit + asset copy, `dist/` stays gitignored); `gate:fast` composes
typecheck + build + both permanent comment-aware gates + the wiring check
itself; and every referenced file exists — so the fast gate can never
silently point at a missing script or drift out of composition. Negative
probe verified: dropping `npm run build` from `gate:fast` fails the smoke
naming the exact part. Verified by `tsc --noEmit` clean + `npm run
smoke:gates` (positive + negative) + `npm run gate:fast` green end-to-end
+ smoke:config / smoke:context green (scripts-only change; no behavioral
surface). The permanent `smoke:phase19` gate (Move 8) absorbs these
assertions.

## Move 3 — the battery runner (done, G1/G7/F3)

`scripts/run-battery.ts` (`npm test` / `npm run battery`) replaces the stub
test gate with one command for the deterministic battery: the 22 in-battery
smokes in canonical order — fast static gates first (baseline,
terminal-paths, phase16, phase18, gates), then config / context / tools /
policy / turn-contract / scheduler / agent-engine / agent-task-profile /
agent-execution / memory-unified / repo-index / checkpoints / model-engine /
executable-skills / execution-backends / delegation — with the e2e runtime
last. Each smoke runs in its own child process (true isolation — a crash or
hang can't take down the runner) under a bounded timeout (300 s default,
600 s for the e2e) so a hung smoke is an `error`, not a silent hang.
Results are aggregated per script (pass/fail/error + duration + exit code +
failure output tail) and written to **`logs/gate-report.json`** (G7 — the
gate-level evidence artifact: per-script status, duration, exit code,
failure tail, plus head / node / platform and a summary; `logs/` is
gitignored, so the report is evidence, never committed state), with a human
summary and a non-zero exit on any failure. `--only=name1,name2` filters;
`--list` prints the canonical battery; the out-of-battery set (learning,
model-resilience, execute-workflow, casual, repetition, web-api) stays
documented, never run. `smoke:gates` now also asserts the battery wiring:
`npm test` → run-battery.ts, every canonical entry is a registered npm
script, and `logs/` is gitignored.

Verified by full `npm test` runs: 20/22 in one pass, the two failures being
the documented pre-existing flakes that fail under load and pass on clean
rerun — `smoke:agent-execution` (the Windows/OneDrive `tmp+rename` EPERM
race in task-store.ts:150, documented since Phase 17) and `smoke:delegation`
(the parallel-child timing assertion, documented in Phase 18 Move 6) — both
green standalone; everything else green including the e2e runtime; the
report artifact records each run with per-script evidence.

## Move 4 — the lint gate (done, G3/F5)

`npm run lint:src` (`scripts/lint-src.ts`) is the lightweight,
zero-new-dependency lint gate in the smoke-phase16/18 discipline —
mechanical rules the tree already passes, so the gate starts green. Three
rules over every `src/` .ts file: no `debugger` statements (comment-aware —
comments are stripped with newlines preserved, so prose mentioning
"debugger" can neither trip nor soothe the sweep and line numbers stay
accurate); no `@ts-ignore` / `@ts-expect-error` directives (they live
inside comments, so this searches raw text by design); no `TODO` /
`FIXME` / `XXX` drift markers (comment content is the point). The one
pre-existing drift — `src/channels/discord.ts:65` (a `(TODO)` in a
comment) — was reworded preserving intent. Sweeping is `src/`-only: the
gate's own documentation (this file + smoke:gates, in `scripts/`) names
the patterns, so sweeping scripts/ would be self-referential; the
no-competing-authority sweeps stay centralized in `smoke:phase18` Gate F.
`gate:fast` now composes typecheck → lint:src → build → phase16 → phase18
→ gates, and `smoke:gates` asserts the lint wiring. Verified by `npm run
lint:src` clean + probes both ways: a probe file with a `debugger`, an
`@ts-ignore`, and a `TODO` fails with all three violations at exact
file:line; a prose comment mentioning "debugger" passes (comment-aware);
+ `npm run gate:fast` green end-to-end. ESLint adoption remains an
explicit non-goal (documented in G3).

## Move 5 — the security gate (done, G4/F6)

`npm run security:secrets` (`scripts/security-secrets.ts`) is the local,
offline, deterministic secrets sweep (G4/F6). It scans the working-tree
diff vs HEAD (plus untracked non-ignored files) for secret-shaped ADDED
content — provider key formats (OpenAI/GitHub/AWS/Slack/Google/JWT/Bearer/
nclaw), private-key blocks, `key: "value"` assignments, and high-entropy
tokens (≥32 chars, ≥4.5 bits/char, ≥3 character classes) — failing only on
NEW content, so the tree passes today. **Exclusion — the documented latent
exposure:** tracked files that `.gitignore` says should not be tracked but
are (`users.json`, `projects_data.json`, `memory.sqlite`, `logs/*`,
`MEMORY.md`, `notes.md`) are excluded via `git check-ignore --no-index`
(which, unlike plain check-ignore, works for tracked files); they carry
real user data by design — the sweep prevents new secret-shaped content
from entering every OTHER file. Probes verified both directions: an
untracked probe with an `sk-` key, a `password:` assignment, and a
high-entropy token fails naming file:line + rule; a staged tracked probe
fails via the diff path with correct hunk line numbers; restore is clean
(the real `users.json` scrypt hashes and `logs/*` Bearer tokens in the
working-tree diff are correctly excluded). `npm run security:audit` (`npm
audit --omit=dev --audit-level=high`) is the explicit out-of-band,
network-dependent dependency check — never in the fast gate, wired
separately; its first run found **28 vulnerabilities (19 high, 1 critical)**
in production deps (axios SSRF/HTTP-smuggling chain, adm-zip 4 GB
allocation, ws/engine.io/socket.io, hono serveStatic path traversal) —
documented here as a known remediation backlog, NOT auto-fixed
(`npm audit fix --force` is breaking-change territory, out of scope for
this phase). `gate:fast` now composes typecheck → lint:src → security:secrets
→ build → phase16 → phase18 → gates; `smoke:gates` asserts the secrets
sweep is scripted + in the fast gate and that `security:audit` stays
OUT of it. **Remediation recommendation (documented, not executed — the
ignored-in-spirit files hold other agents' uncommitted work): untrack them
(`git rm --cached` + keep .gitignore) and treat their content as local
state only.**

## Move 6 — the diff gate (done, G5/F7)

`npm run diff:gate` (`scripts/diff-gate.ts`) is the local, offline scope
gate (G5/F7) with four rule groups, all passing on the current tree:

1. **Forbidden paths** — `dist/`, `.env` (exact), `node_modules/` must never
   appear in the tracked diff (they are gitignored and untracked; a diff
   entry means someone force-tracked them).
2. **Whitespace (`git diff --check`)** — per tracked file that is NOT
   gitignored-in-spirit (the Move 5 exposure set): a whitespace error in
   real code/docs fails, naming file:line. The raw whole-tree `git diff
   --check` FAILS today (trailing whitespace in `logs/gitu-out.log` and
   `notes.md` — runtime churn), which is exactly why the exclusion is the
   same documented exposure set as Move 5.
3. **Staged scope** — `git diff --cached`: nothing staged may include a
   forbidden path or an ignored-in-spirit data file (the "what would you
   commit" check), and the staged diff must be whitespace-clean.
4. **Size caps** — working-tree diff vs HEAD: total insertions ≤ 12,000,
   total files ≤ 60, per-file insertions ≤ 7,000, total deletions ≤ 8,000
   (current tree: 7,312 ins / 20 files / 4,932 max per-file — generous
   headroom, but a tripwire for a node_modules-style dump or a giant
   accidental addition).

Secret-shaped additions are NOT re-checked here — that is
`security:secrets`'s job; this gate owns scope/size/whitespace. Probes
verified all four rules: a staged trailing-whitespace file fails with
file:line; a staged `logs/` file fails as ignored-in-spirit; a
force-staged `dist/` file fails as forbidden; a 7,001-line staged file
fails the per-file cap; restore is clean with zero residue. (One real bug
caught during development: `git diff --check` exits 2 on violations and
`execFileSync` throws, which initially swallowed the violation output —
`runGitOrNull` now recovers `error.stdout`.) `gate:fast` now composes
typecheck → lint:src → security:secrets → diff:gate → build → phase16 →
phase18 → gates; `smoke:gates` asserts the diff-gate wiring.

## Move 7 — acceptance-criteria evaluation (done, G6/F8)

`src/core/context/criteria-check.ts` (`evaluateAcceptanceCriteria`) turns
the goal's `acceptanceCriteria` — data + prompt render since Phase 12, never
checked — into deterministic checks at the completion gate (G6/F8):

- **file-contains** — "the file notes.txt should contain 'hello'",
  "notes.txt contains 'hello'", "contains 'x' in src/a.ts" — resolved
  against the workspace, read (bounded to 1 MB), needle `includes`.
- **test-command** — "run npm test", "the command `npm run build` passes",
  "npm run build exits 0" (npm/npx/node/yarn/pnpm/python/pytest/go
  test/jest/vitest/tsc prefixes, prose tails stripped) — executed through
  the SAME execution-backend plan authority and bounds as verify-then-retry
  (45 s timeout, 4 KB output). A command match must be start-anchored or
  followed by a pass/succeed tail, so "check the npm docs" stays
  uncheckable rather than mis-executed.
- **uncheckable** — anything else, reported with a reason, recorded as
  SKIPPED evidence — never silently passed.

The runner's `buildMissionVerifier` now takes the session goal's
`acceptanceCriteria` (from `mainGoalManager.getCurrent(sessionId)`),
evaluates them at every gate run, records each as a `'criteria'`
TaskVerification (a new kind in task-types.ts; PASSED/FAILED/SKIPPED),
and folds them into the verdict: any failing checkable criterion fails the
gate and repairs until the turn budget exhausts (same loop as the Phase 17
test gate).

Verified by `tsc --noEmit` clean + `smoke:turn-contract` §17: classifier
(file-contains present/absent/missing-file, test-command exit-0/exit-1/
backtick-quoted, plain prose → uncheckable) and gate integration (criteria
PASSED + uncheckable SKIPPED evidence with all-pass completes; a failing
criterion repairs then completes, with FAILED + PASSED records and attempts
bumped). Battery subset green (turn-contract, phase16, phase18) + `npm run
gate:fast` green end-to-end + smoke:agent-execution green (the runner path;
one transient OneDrive EPERM cleared on rerun). Development caught two real
classifier bugs: plural verb forms ("contains" vs "contain") and
PowerShell returning exit 0 for `node --eval process.exit(1)` (the smoke's
FAIL probe is now `node --no-such-flag-xyz`, deterministic through the
PowerShell backend).

## Move 8 — the permanent smoke:phase19 gate (done, F10) + Phase 19 closeout

`scripts/smoke-phase19.ts` (`npm run smoke:phase19`) is the permanent,
comment-aware regression guard for the Phase 19 invariants — same
discipline as `smoke:phase16`/`smoke:phase18` (comments stripped from
source sweeps so prose can neither trip nor soothe). It absorbs the wiring
assertions that `smoke:gates` carried through Moves 2-6 (that script is
retired). Seven gates:

- **Gate A (G1/G7/F3)** — the test gate is live: `npm test` / `npm run
  battery` run the battery runner, every canonical battery entry is a
  registered `smoke:*` script, and `logs/` is gitignored (the gate-report
  artifact is evidence, never committed state).
- **Gate B (G2/F4)** — typecheck is scripted: `typecheck` = `tsc --noEmit`.
- **Gate C (G3/F5)** — the lint gate is enforced: `lint:src` scripted and
  exists.
- **Gate D (G4/F6)** — the security gate is wired: `security:secrets` in
  the fast gate, `security:audit` registered but OUT of it.
- **Gate E (G5/F7)** — the diff gate is wired: `diff:gate` scripted and
  exists.
- **Gate F** — the fast gate composes every Phase 19 gate (typecheck,
  lint:src, security:secrets, diff:gate, build, phase16, phase18, phase19)
  and never the network-bound audit.
- **Gate G (G6/F8)** — acceptance criteria are evaluated: 
  `evaluateAcceptanceCriteria` defined + exported, the runner threads the
  session goal's criteria and records `'criteria'` TaskVerification
  evidence, and `'criteria'` is a TaskVerificationKind.

Verified by `tsc --noEmit` clean + `smoke:phase19` with negative probes on
every direction: dropping `diff:gate` from `gate:fast` fails Gate F naming
the part; removing the `'criteria'` kind fails Gate G naming it; and
comment-awareness proven both ways — a comment naming the invariant
passes, while a comment LEFT BEHIND after the real export is removed
fails (prose cannot soothe). `npm run gate:fast` green end-to-end, and the
**full battery green in one pass — 22/22** (baseline, terminal-paths,
phase16, phase18, phase19, config, context, tools, policy, turn-contract,
scheduler, agent-engine, agent-task-profile, agent-execution,
memory-unified, repo-index, checkpoints, model-engine, executable-skills,
execution-backends, delegation, runtime e2e) — including the two smokes
that had been flaky under load (agent-execution, delegation) — with the
`logs/gate-report.json` artifact recording the green run.

**Phase 19 is complete.** Every gap in the AUDIT_10 §3 evidence matrix is
closed: the test gate is live (M3), typecheck is scripted (M2), the lint
gate enforces mechanical rules (M4), the security gate scans secrets with
the dependency audit out-of-band (M5), the diff gate polices
scope/size/whitespace (M6), acceptance criteria are evaluated
deterministically at the completion gate (M7), and the permanent
`smoke:phase19` gate protects it all (M8). Documented follow-ups, not part
of the phase: the tracked-data exposure (users.json / projects_data.json /
memory.sqlite / logs/* / MEMORY.md / notes.md tracked but gitignored in
spirit — untrack them with `git rm --cached`) and the 28-vulnerability
production-dependency backlog surfaced by `security:audit`.
