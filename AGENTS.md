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
│   ├── decisions/           # ADRs by active MECE category: {ml,backend,frontend,common}/
│   ├── rules/               # Standing conventions (e.g. streamlit-demo.md); ADRs must be MECE
│   ├── architecture.md      # System overview
│   └── Tools.md             # MCP tooling notes
├── .githooks/               # committed git hooks; activated by core.hooksPath
├── scripts/
│   └── git-guard/           # shared enforcement scripts (assert-not-main, check-freshness, deny-assets, wt) — ADR-008/016
├── ml/                      # ML uv project (ADR-001, ADR-022)
│   ├── data/                # domain-first {nursing-home,le2i,…}/{raw,processed,poses} — rules/ml-filesystem-layout.md (ADR-012) · gitignored
│   ├── models/              # model single root {pose,fall} + metadata.json contract — rules/ml-models.md (ADR-015) · gitignored
│   ├── demo/                # Streamlit demo — rules/streamlit-demo.md (ADR-010/011)
│   ├── serving/             # FastAPI inference lifecycle / ML-backend boundary (ADR-022/023)
│   └── training/            # training pipeline (ADR-013, lifecycle boundary ADR-022)
├── backend/                 # NestJS alert policy / KakaoTalk webhooks (ADR-001)
├── front/                   # Next.js dashboard (ADR-001)
├── .omc/                    # omc scratch (specs/, plans/) — not git canonical
├── .omo/                    # omo scratch (plans/) — not git canonical
├── .omx/                    # omx scratch (plans/) — not git canonical
├── .gjc/                    # gjc (gajae-code) scratch (specs/, plans/, state/) — not git canonical
├── AGENTS.md                # <- this file (single source of truth)
├── README.md                # Project overview / team setup
└── .mcp.json                # MCP server definitions (project scope)
```

## Development Flow

> Issue-driven 루프. AGENTS.md는 라우팅만 담고, 실제 메커니즘은 링크된 rules에 위임한다(SSOT).

```
plan/spec → issue(`type:` 라벨 1개) → `git wt <issue#>` → PR(리뷰가능·필요시 fan-out) → 리뷰 + CI → merge → plan archive + ADR distill
```

1. **Plan** — 먼저 spec/plan 작성 (아래 [Lifecycle](#lifecycle) · [Conventions](#conventions) › plan-first mandate).
2. **Issue** — GitHub 이슈에 정확히 하나의 `type:` 라벨 부여(branch `<type>`를 결정). → [`docs/rules/github-labels.md`](docs/rules/github-labels.md)
3. **Worktree** — `git wt <issue#>`로 worktree/브랜치 생성 (절대 `main`에서 직접 분기 금지). → [`docs/rules/worktree-workflow.md`](docs/rules/worktree-workflow.md) · ADR-008
4. **PR** — 하나의 리뷰 가능한 변경; 큰 작업은 한 이슈 → fan-out PR로 분해. → [`docs/rules/pr-decomposition-and-review.md`](docs/rules/pr-decomposition-and-review.md)
5. **Review + CI** — 모든 PR은 리뷰를 거치고, size/base/draft 게이트가 CI에서 돈다. → [`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml)
6. **Merge → archive → ADR** — merge 후 plan archive, expensive-to-reverse 결정은 ADR로 distill. → [`docs/decisions/README.md`](docs/decisions/README.md)

## Artifact Ontology

Four artifact types with non-overlapping responsibilities:

| Artifact | Question answered | Lifespan | Author | Canonical location |
|----------|------------------|----------|--------|--------------------|
| **research** | *What did I find* — facts, sources, comparisons (pre-decision) | Topic-scoped; superseded as evidence evolves | deep-research / research passes | `docs/research/{slug}.md` |
| **spec** | *What* is this work / are requirements clear? | Work-scoped, one-shot | deep-interview skill | `docs/exec-plan/active/{slug}/spec.md` |
| **plan** | *How* to implement (steps, files, order) | Work-scoped, body immutable; lifecycle = folder position | omc-plan / omo / omx | `docs/exec-plan/active/{slug}/plan.md` |
| **ADR** | One expensive-to-reverse decision: ecosystem-local (`ml`, `backend`, `frontend`) or strict `common` after split | Work-independent; current ADRs persist, while fully superseded non-MECE source bundles may be retired from the visible corpus with coverage-matrix proof and git-history recovery | documentation-and-adrs | `docs/decisions/{ml,backend,frontend,common}/ADR-NNN-*.md` |

**The decision pipeline:** `research` (facts I found) → `ADR` (decision I made) → `plan` (implementation I built).
Research collects evidence; it does **not** decide. A decision distilled from research is an **ADR**; how to
build that decision is a **plan**. Never let a research doc assert a decision — it presents options and findings,
the human (or a later ADR) chooses.

**Key principle:** plan != ADR. A plan is archived when its work ends. Any expensive-to-reverse
choice made inside a plan is **distilled** into a new ADR under the correct MECE category in
`docs/decisions/{ml,backend,frontend,common}/` — the plan entry itself is not replaced.

### Boundary: plan vs ADR

Plans and ADRs answer different questions with different lifespans. Never conflate them.

| | plan (`docs/exec-plan/`) | ADR (`docs/decisions/`) |
|---|---|---|
| Question | *How* to implement this specific work | *Why* this expensive-to-reverse choice — and what alternatives were rejected |
| Scope | One feature / task (work-scoped) | Ecosystem-local (`ml`, `backend`, `frontend`) or strict common if it still constrains multiple domains after attempted split |
| Lifespan | Archivable when work ends | Permanent as current authority; fully superseded non-MECE source files may be retired only after successor coverage is proven |
| Body | Immutable after finalize; scope change → new slug | Superseded by successor ADR(s); retired source bodies must remain recoverable from git history and mapped in the coverage matrix |
| Author | omc-plan / omo / omx agents | documentation-and-adrs skill |
| Location | `docs/exec-plan/active/{slug}/plan.md` → `archive/{slug}/` | `docs/decisions/{ml,backend,frontend,common}/ADR-NNN-*.md` |

#### Distill rule

When a plan contains an expensive-to-reverse choice (framework selection, data model,
auth strategy, API shape, infrastructure, repository workflow, safety policy), **distill that
choice into a new ADR** before or at the time the plan is archived. Place it in the owning
ecosystem category. Use `common/` only after attempted split proves the decision still
irreducibly constrains multiple top-level domains.

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
     v  plan contained an expensive-to-reverse ecosystem-local or strict-common decision?
     |
distill  -->  docs/decisions/{ml,backend,frontend,common}/ADR-NNN-{topic}.md   (ADRs are never deleted)
```

## Locations

| Store | Role | Git canonical? |
|-------|------|---------------|
| `docs/research/` | Fact collection — findings, sources, comparisons (pre-decision) | Yes |
| `docs/exec-plan/active/{slug}/` | In-progress spec + plan | Yes |
| `docs/exec-plan/archive/{slug}/` | Completed / discarded spec + plan | Yes |
| `docs/decisions/{ml,backend,frontend,common}/` | ADRs (permanent, active MECE by category) | Yes |
| `docs/rules/` | Standing conventions (ongoing constraints, not work-scoped) | Yes |
| `.omc/specs/` | deep-interview scratch output | No — scratch only |
| `.omc/plans/` | omc tool scratch / drafts | No — scratch only |
| `.omo/plans/` | omo tool scratch / drafts | No — scratch only |
| `.omx/plans/` | omx tool scratch / drafts | No — scratch only |
| `.gjc/specs/` | deep-interview scratch output (gjc) | No — scratch only |
| `.gjc/plans/` | ralplan / gjc tool scratch / drafts | No — scratch only |

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
`.agents/skills/` is the **single source of truth** for the project skill set.
`.claude/skills/` and `.codex/skills/` are per-skill symlinks into `.agents/skills/`
(`<name> -> ../../.agents/skills/<name>`), so the three runtimes always read identical
content and drift is structurally impossible — edit a skill once under `.agents/skills/`.
**Adding a new skill:** create it under `.agents/skills/<name>/`, then add the matching
symlink in both `.claude/skills/` and `.codex/skills/`. Never create a real skill directory
under `.claude/skills/` or `.codex/skills/` — that reintroduces the duplicate-copy drift this
layout exists to prevent.

**Enabling GJC skill discovery (per checkout).** Discovery is off by default. To call
repo skills (e.g. `/skill:documentation-and-adrs`) from a GJC session, enable it locally
in `.gjc/settings.json` (gitignored — per checkout, not committed):
`{"skills":{"enabled":true,"enableClaudeProject":true}}`. `.claude/skills` symlinks resolve
to `.agents/skills`, so the single source is exposed without duplication. Invoke skills
manually on-demand (e.g. distill ADRs with `/skill:documentation-and-adrs` when work lands);
no automatic hooks or cron.

### Worktree workflow
Every task must be developed on a dedicated worktree off a `<type>/<issue#>-<slug>` branch.
Use `git wt <issue#>` — never branch directly from `main` or hand-roll `git worktree add`.
The `git wt` alias is registered by `scripts/git-guard/setup-hooks.sh` (run once per clone).

Standing rule: `docs/rules/worktree-workflow.md`.
Enforcement layer: `scripts/git-guard/` + `.githooks/` (via `core.hooksPath`).

PR decomposition rule: `docs/rules/pr-decomposition-and-review.md` — split `size/L`/`size/XL` work into reviewable `size/M`-or-smaller PR slices and record per-PR review evidence.

### ADR lifecycle (cross-reference)
ADRs follow `PROPOSED -> ACCEPTED -> (SUPERSEDED | PARTIALLY SUPERSEDED | DEPRECATED)`. When a decision changes or an active ADR is non-atomic, write successor ADR(s) that reference and supersede the old one. A fully superseded non-MECE source ADR may be retired from the visible corpus only when `docs/decisions/README.md` maps every clause to active successors and the exact source body remains recoverable from git history.

### Provider review lanes

This repo may use Claude Code, Codex, and Gemini as complementary advisory review lanes:

- Claude Code/GJC owns orchestration, repo-local context management, subagent delegation, and final integration responsibility.
- Codex is useful for independent candidate/review passes grounded in this `AGENTS.md`, especially placement disagreements and implementation sanity checks.
- Gemini is useful for adversarial or sanity-check review, especially omission risk, stale links, and category-boundary challenges.

No provider is merge authority. Durable rules live in repo docs (`AGENTS.md`, `docs/decisions/README.md`, `docs/rules/`) and final acceptance depends on the validated diff, coverage matrix, verification evidence, and human review.
