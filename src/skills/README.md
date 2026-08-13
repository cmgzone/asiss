# Skills — index-backed context queries

The agent's tools are skills; most of the *repository-intelligence* skills are
thin, structured queries over the **persistent repository index** (`repo-index`,
built/warmed by `ContextEngine`) — instant and tolerant ("not a compiler").
All of them **force-warm the index before answering**, so an explicit query
never reads a stale one. Prefer these over shell greps whenever the question
is one of the four below.

## Which question → which skill

| You want to know... | Skill | Implementation |
| --- | --- | --- |
| **Where is this symbol defined?** ("where does `authenticate` live?") | `/symbol` | `src/skills/symbol.ts` — defining files via the `exportedSymbols` map, with kind + line |
| **Is the index fresh? / rebuild it** ("why is the repo context stale?") | `/warmth` | `src/skills/warmth.ts` — last refresh, files/symbols re-parsed, freshness status; force an incremental refresh |
| **What is the architecture?** ("what are the entry points / services / workers?") | `/architecture` | `src/skills/architecture.ts` — convention-based role buckets (entry / service / worker / database / integration / test / config) |
| **What is the smallest dependency-closed file set for this change?** ("what files do I need for the auth fix?") | `/minimal_context` | `src/skills/minimal-context.ts` — goal → seeds → imported/importing modules → related tests, budget-bounded, with `closed`/`truncated` status; also the closure around **one file** (`file:` param) |

## How they fit together

- **`/symbol`** answers *definition* questions — the leaf of a change.
- **`/warmth`** answers *freshness* questions — run it before trusting any
  other index-backed answer, or rely on the force-warm each skill already does.
- **`/architecture`** answers *shape* questions — a whole-repo overview.
- **`/minimal_context`** answers *change-surface* questions — it builds on
  `/symbol`'s matching and adds the dependency closure + tests, so it is the
  right first stop before editing: pick the goal (or the one file you are
  changing) and read the surfaced closure.

The same index backs deeper programmatic queries on `ContextEngine` — reverse
dependents (`dependents`), change-impact (`changeImpact`), and the
usage-reference map (`callersOf` / `calleesOf` / `implementationsOf`) — see
`docs/hermes/AUDIT_9.md` (Phase 18) for the full surface.
