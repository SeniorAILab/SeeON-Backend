# AGENTS

> Single source of truth for all runtimes (Claude Code, Codex, agents).
> `.claude/CLAUDE.md`, `.codex/`, `.agents/` entry points defer here — no content duplication.

## Way point

```
.
├── docs/
│   ├── research/            # Fact collection — what I found (sources, comparisons), pre-decision
│   ├── exec-plan/           # All work-scoped plans (active + archive)
│   │   ├── active/{slug}/   #   spec.md + plan.md while work is in progress
│   │   └── archive/{slug}/  #   same folder after done / discarded / superseded
│   ├── decisions/           # Cross-cutting ADRs (ADR-001..N, permanent, never deleted)
│   ├── rules/               # Standing conventions (e.g. streamlit-demo.md); ADRs must be MECE
│   ├── architecture.md      # System overview
│   └── Tools.md             # MCP tooling notes
├── .githooks/               # committed git hooks; activated by core.hooksPath
├── scripts/
│   └── git-guard/           # shared enforcement scripts (assert-not-main, check-freshness, deny-assets, wt) — ADR-008/016
├── ml/                      # ML uv project (ADR-001, ADR-003)
│   ├── data/                # domain-first {nursing-home,le2i,…}/{raw,processed,poses} — rules/ml-filesystem-layout.md (ADR-012) · gitignored
│   ├── models/              # model single root {pose,fall} + metadata.json contract — rules/ml-models.md (ADR-015) · gitignored
│   ├── demo/                # Streamlit demo — rules/streamlit-demo.md (ADR-010/011)
│   ├── serving/             # FastAPI inference (ADR-003)
│   └── training/            # training pipeline (ADR-003, ADR-013)
├── backend/                 # NestJS alert policy / KakaoTalk webhooks (ADR-001)
├── front/                   # Next.js dashboard (ADR-001)
├── .omc/                    # omc scratch (specs/, plans/) — not git canonical
├── .omo/                    # omo scratch (plans/) — not git canonical
├── .omx/                    # omx scratch (plans/) — not git canonical
├── AGENTS.md                # <- this file (single source of truth)
├── README.md                # Project overview / team setup
└── .mcp.json                # MCP server definitions (project scope)
```

## Artifact Ontology

Four artifact types with non-overlapping responsibilities:

| Artifact | Question answered | Lifespan | Author | Canonical location |
|----------|------------------|----------|--------|--------------------|
| **research** | *What did I find* — facts, sources, comparisons (pre-decision) | Topic-scoped; superseded as evidence evolves | deep-research / research passes | `docs/research/{slug}.md` |
| **spec** | *What* is this work / are requirements clear? | Work-scoped, one-shot | deep-interview skill | `docs/exec-plan/active/{slug}/spec.md` |
| **plan** | *How* to implement (steps, files, order) | Work-scoped, body immutable; lifecycle = folder position | omc-plan / omo / omx | `docs/exec-plan/active/{slug}/plan.md` |
| **ADR** | One expensive-to-reverse *cross-cutting* decision that constrains all future plans | Work-independent, permanent (superseded only, never deleted) | documentation-and-adrs | `docs/decisions/ADR-NNN-*.md` |

**The decision pipeline:** `research` (facts I found) → `ADR` (decision I made) → `plan` (implementation I built).
Research collects evidence; it does **not** decide. A decision distilled from research is an **ADR**; how to
build that decision is a **plan**. Never let a research doc assert a decision — it presents options and findings,
the human (or a later ADR) chooses.

**Key principle:** plan != ADR. A plan is archived when its work ends. Any expensive-to-reverse
cross-cutting choice made inside a plan is **distilled** into a new ADR in `docs/decisions/` —
the plan entry itself is not replaced.

### Boundary: plan vs ADR

Plans and ADRs answer different questions with different lifespans. Never conflate them.

| | plan (`docs/exec-plan/`) | ADR (`docs/decisions/`) |
|---|---|---|
| Question | *How* to implement this specific work | *Why* this cross-cutting choice — and what alternatives were rejected |
| Scope | One feature / task (work-scoped) | Cross-cutting — constrains all future work |
| Lifespan | Archivable when work ends | Permanent — superseded only, never deleted |
| Body | Immutable after finalize; scope change → new slug | Superseded by a new ADR that references the old one |
| Author | omc-plan / omo / omx agents | documentation-and-adrs skill |
| Location | `docs/exec-plan/active/{slug}/plan.md` → `archive/{slug}/` | `docs/decisions/ADR-NNN-*.md` |

#### Distill rule

When a plan contains an expensive-to-reverse, cross-cutting choice (framework selection, data model,
auth strategy, API shape, infrastructure), **distill that choice into a new ADR** before or at the
time the plan is archived. The plan entry itself is not replaced — the ADR lives alongside it in
`docs/decisions/`.

Ask: "Would a future agent/engineer working on an unrelated feature need to know this decision?"
If yes → write an ADR. If it only affects this feature's implementation details → leave it in the plan.

#### Do NOT write an ADR for

- Implementation steps or file-level details (those belong in the plan)
- Choices that will be revisited within this same work item
- Trivial configuration values with no architectural consequence

## Lifecycle

```
deep-interview
     |
     v  produces spec.md  ->  .omc/specs/deep-interview-{slug}.md  (scratch, not git canonical)
     |
     v  [first act of planning]  MOVE  ->  docs/exec-plan/active/{slug}/spec.md
     |                                     (delete .omc/specs/ source after move)
     |
     +-- planning abandoned before plan.md is written? (spec-only closure)
     |   set status: discarded in spec.md frontmatter
     |   move folder to archive/{slug}/  -- done
     |
omc-plan / omo / omx
     |
     v  produces plan.md  ->  docs/exec-plan/active/{slug}/plan.md
     |                        FINALIZED on first git commit that includes this file
     |                        (body is immutable from that point)
     |
autonomous execution
     |
     v  work complete, discarded, or superseded?
     |
     +-->  add frontmatter to plan.md (or spec.md for spec-only folders):
     |       status: done | discarded | superseded-by
     |       superseded-by: {new-slug}   # required when status: superseded-by
     |
     |  [superseded only] when creating plan-B, archive plan-A in the SAME action
     |                    before execution of plan-B begins
     |
     v
move entire folder:  active/{slug}/  -->  archive/{slug}/
     |
     v  plan contained a cross-cutting or expensive-to-reverse decision?
     |
distill  -->  docs/decisions/ADR-NNN-{topic}.md   (ADRs are never deleted)
```

## Locations

| Store | Role | Git canonical? |
|-------|------|---------------|
| `docs/research/` | Fact collection — findings, sources, comparisons (pre-decision) | Yes |
| `docs/exec-plan/active/{slug}/` | In-progress spec + plan | Yes |
| `docs/exec-plan/archive/{slug}/` | Completed / discarded spec + plan | Yes |
| `docs/decisions/` | ADRs (permanent) | Yes |
| `docs/rules/` | Standing conventions (ongoing constraints, not work-scoped) | Yes |
| `.omc/specs/` | deep-interview scratch output | No — scratch only |
| `.omc/plans/` | omc tool scratch / drafts | No — scratch only |
| `.omo/plans/` | omo tool scratch / drafts | No — scratch only |
| `.omx/plans/` | omx tool scratch / drafts | No — scratch only |

## Conventions

### plan-first mandate
Every *meaningful* change must have a `docs/exec-plan/active/{slug}/` entry **before** any code is
modified. Enforcement is convention-level (no hook-based hard gate this cycle).

### Trivial exemptions — no plan required
- Typo / comment / doc wording fixes
- Lint or format-only changes
- Dependency patch-version bumps (`x.y.Z`)
- Purely behavior-preserving renames

### plan immutability
A plan is **finalized** on the first git commit that includes `plan.md` in `docs/exec-plan/active/`.
From that point the plan body is immutable. If scope changes, **create a new slug** and set the
old plan's frontmatter to:
```
status: superseded-by
superseded-by: {new-slug}
```
Only the frontmatter `status` and `superseded-by` lines are mutable post-finalize.

### Archive trigger — manual and explicit
When work is done or discarded:
1. Add status line(s) to `plan.md` frontmatter (or `spec.md` if no plan was written):
   - `status: done` or `status: discarded` — one line only.
   - `status: superseded-by` — add a second line `superseded-by: {new-slug}`.
2. Move the entire `active/{slug}/` folder to `archive/{slug}/`.

**Supersede timing:** When creating a superseding plan (plan-B), archive the superseded plan
(plan-A) in the same action before beginning execution of plan-B.

No automation (hooks, merge triggers) in this cycle.

### Slug naming
Format: `{kebab-description}` — lowercase, hyphens only, no date prefix, no issue numbers.
Date and author live in frontmatter, not in the folder name.
**The folder name is authoritative as the slug.** The frontmatter `slug` field must be
identical to the folder name — treat a mismatch as an error.

Examples:
- `agent-driven-docs-execplan-convention`
- `streamlit-preprocessed-poc`

### Skill mirrors
`.claude/skills/`, `.agents/skills/`, and `.codex/skills/` carry the same skill set.
`.codex/skills/` is symlinked to `.agents/skills/`. Do not diverge content between mirrors.

### Worktree workflow
Every task must be developed on a dedicated worktree off a `<type>/<issue#>-<slug>` branch.
Use `git wt <issue#>` — never branch directly from `main` or hand-roll `git worktree add`.
The `git wt` alias is registered by `scripts/git-guard/setup-hooks.sh` (run once per clone).

Standing rule: `docs/rules/worktree-workflow.md`.
Enforcement layer: `scripts/git-guard/` + `.githooks/` (via `core.hooksPath`).

PR decomposition rule: `docs/rules/pr-decomposition-and-review.md` — split `size/L`/`size/XL` work into reviewable `size/M`-or-smaller PR slices and record per-PR review evidence.

### ADR lifecycle (cross-reference)
ADRs follow `PROPOSED -> ACCEPTED -> (SUPERSEDED | DEPRECATED)`. Never delete. When a decision
changes, write a new ADR that references and supersedes the old one. See `docs/decisions/README.md`.

## gstack (recommended)

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows
(plan review, code review, QA, release). Team mode: the install is **global**, this repo
only carries this bootstrap section — no vendored files, no version drift.

Install (once per developer; covers Claude Code and Codex):

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack && ./setup --team --host auto --prefix --no-plan-tune-hooks
```

Conventions in this repo:
- Skills are installed with the `gstack-` prefix (`/gstack-review`, `/gstack-qa`,
  `/gstack-ship`, `/gstack-office-hours`, `/gstack-investigate`, `/gstack-browse`, …)
  to avoid collisions with built-in `/review` and omc skills.
- Use `/gstack-browse` for web browsing in gstack workflows; never `mcp__claude-in-chrome__*` tools.
- gstack file paths are global: `~/.claude/skills/gstack/...`
- This section is the single source for all runtimes — Codex reads AGENTS.md natively;
  `.claude/CLAUDE.md` defers here. Do not duplicate into per-runtime files.
