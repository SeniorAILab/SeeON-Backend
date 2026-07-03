# AGENTS

> Single source of truth for all runtimes (Claude Code, Codex, agents).
> `.claude/CLAUDE.md`, `.codex/`, `.agents/` entry points defer here — no content duplication.

## Way point

```
.
├── docs/                    # documentation ontology/lifecycle rules → docs/AGENTS.md
│   ├── research/            # Fact collection — what I found (sources, comparisons), pre-decision
│   ├── exec-plan/           # All work-scoped plans (active + archive)
│   │   ├── active/{slug}/   #   spec.md + plan.md while work is in progress
│   │   └── archive/{slug}/  #   same folder after done / discarded / superseded
│   ├── decisions/           # ADR home after reset (no ADR-NNN files currently)
│   ├── rules/               # Standing conventions (e.g. streamlit-demo.md)
│   ├── api/                 # API/serving shape notes (route-inventory, ml-serving, kakao, edge-ingest)
│   ├── domain/              # alert pipeline + data dictionary
│   ├── architecture.md      # System overview
│   └── Tools.md             # MCP tooling notes
├── .githooks/               # committed git hooks; activated by core.hooksPath
├── scripts/                 # repo guard/deploy/release automation → scripts/AGENTS.md
│   ├── git-guard/           # shared enforcement scripts (assert-not-main, check-freshness, deny-assets, sync-main)
│   └── backend-guard/       # backend layering/DTO enforcement: schema↔migration guard
├── ml/                      # Python/uv edge runtime — L0→L4 layers, guards, run → ml/AGENTS.md
├── backend/                 # NestJS alert policy / KakaoTalk webhooks → backend/AGENTS.md
├── front/                   # Vite + React dashboard (SSOT) → front/AGENTS.md
├── .omc/                    # omc scratch (specs/, plans/) — not git canonical
├── .omo/                    # omo scratch (plans/) — not git canonical
├── .omx/                    # omx scratch (plans/) — not git canonical
├── .gjc/                    # gjc (gajae-code) scratch (specs/, plans/, state/) — not git canonical
├── AGENTS.md                # <- this file (single source of truth)
├── README.md                # Project overview / team setup
└── .mcp.json                # MCP server definitions (project scope)
```

## Run / Boot

> 멀티에이전트/신규 클론 30초 구동 웨이포인트. 상세는 [README.md](README.md) Quick Start (중복 금지·여기는 라우팅).

| Service | URL | Start (native) |
|---|---|---|
| backend + db (NestJS/Postgres) | `http://localhost:8080` / `localhost:5432` | `pnpm dev:backend` (`pnpm dev:backend:fresh` for reset+seed) |
| ml-api (FastAPI) | `http://localhost:8000` | `pnpm dev:ml` |
| ml-worker (RTSP) | — | `pnpm dev:ml:worker` |
| front (Vite + React) | `http://localhost:3000` | `pnpm dev:front` |
| ml demo (Streamlit) | — | `pnpm dev:ml:demo` |

First-time: `pnpm install` → `cd ml && uv sync` → `cp .env.local.example .env.local` → `pnpm dev:backend:fresh`.

- **Env 위치**: local/native/Prisma/Compose는 루트 `.env.local`, host prod는 루트 `.env.host.prod`, edge prod는 루트 `.env.edge.prod`를 읽는다. 실제 `.env*`는 gitignored, tracked 계약은 `.env.local.example`/`.env.host.prod.example`/`.env.edge.prod.example`. `backend/.env*`/`front/.env*`/`ml/.env*`는 만들지 않는다.
- **ml-worker config**: `pnpm dev:ml:worker`는 `python -m worker`로 gitignored `ml/config/ml-worker.local.yaml`를 읽는다(`--config` 기본 내장). 최초 1회 `cp ml/config/ml-worker.example.yaml ml/config/ml-worker.local.yaml` 후, 네이티브 dev(`uv run --directory ml`, cwd=`ml/`)용으로 `artifact_dir: ./models/fall/lstm`(경로는 `ml/` 기준)와 실제/외부 RTSP `rtsp_url`을 설정한다. `python -m worker.edge_worker`도 그대로 유효. 단독 검증: `pnpm dev:ml:worker --check-config`.
- **Verify**: `pnpm typecheck` · `pnpm lint` · backend `pnpm --filter backend test` · ml `uv run --directory ml pytest` · front `pnpm --filter front test`.
- **Compose**: backend-owned db만 `pnpm backend:db:up` / 풀 로컬 호스트 스택 `pnpm compose:local:up` (`.env.local`, `--profile full`) / prod 호스트 스택 `pnpm compose:prod:up` (`.env.host.prod` image pins). 일상 dev는 네이티브 hot reload(`pnpm dev:*`)이며 컨테이너-dev override는 없다.
- **Demo(라이브 낙상→카카오 fan-out E2E)**: 절차는 README Quick Start + `.env.local.example`, durable 기록은 `docs/exec-plan/active/thursday-mvp-live-fall-kakao-fanout/`.

## Development Flow

> Issue-driven 루프. AGENTS.md는 라우팅만 담고, 실제 메커니즘은 링크된 rules에 위임한다(SSOT).

```
plan/spec → issue(`type:` 라벨 1개) → idle lane에서 `git switch -c <type>/<issue#>-<slug> origin/main` → PR(리뷰가능·필요시 fan-out) → 리뷰 + CI → merge → plan archive + ADR/rule update → docs 준수검증
```

1. **Plan** — 먼저 spec/plan 작성 (아래 [Lifecycle](#lifecycle) · [Conventions](#conventions) › plan-first mandate).
2. **Issue** — GitHub 이슈에 정확히 하나의 `type:` 라벨 부여(branch `<type>`를 결정). → [`docs/rules/github-labels.md`](docs/rules/github-labels.md)
3. **Worktree** — 미리 만들어 둔 idle lane에서 `git switch -c <type>/<issue#>-<slug> origin/main`로 브랜치 생성 (절대 `main`에서 직접 작업 금지; lane은 재사용, 삭제 금지). → [`docs/rules/worktree-workflow.md`](docs/rules/worktree-workflow.md)
4. **PR** — 하나의 리뷰 가능한 변경; 큰 작업은 한 이슈 → fan-out PR로 분해. → [`docs/rules/pr-decomposition-and-review.md`](docs/rules/pr-decomposition-and-review.md)
5. **Review + CI** — 모든 PR은 리뷰를 거치고, size/base/draft 게이트가 CI에서 돈다. → [`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml)
6. **Merge → archive → ADR/rule update** — merge 후 plan archive, ADR로 남길 만큼 expensive-to-reverse인 결정은 `docs/decisions/README.md`에 짧게 반영하고, 실행 규칙은 owning rule/API/domain/onboarding 문서에 둔다. → [`docs/decisions/README.md`](docs/decisions/README.md)
7. **Document** — 마지막 단계로 craft-skills의 `/skill:documents`를 돌려 변경이 `docs/rules/` 컨벤션과 ADR 지침을 준수했는지(위반 없음) 검증하고, spec/plan이 `docs/exec-plan/`에 누적·아카이브됐는지 확인한다. → [`docs/rules/README.md`](docs/rules/README.md) · [`docs/decisions/README.md`](docs/decisions/README.md)

## Artifact Ontology

Four artifact types with non-overlapping responsibilities:

| Artifact | Question answered | Lifespan | Author | Canonical location |
|----------|------------------|----------|--------|--------------------|
| **research** | *What did I find* — facts, sources, comparisons (pre-decision) | Topic-scoped; superseded as evidence evolves | deep-research / research passes | `docs/research/{slug}.md` |
| **spec** | *What* is this work / are requirements clear? | Work-scoped, one-shot | deep-interview skill | `docs/exec-plan/active/{slug}/spec.md` |
| **plan** | *How* to implement (steps, files, order) | Work-scoped, body immutable; lifecycle = folder position | omc-plan / omo / omx | `docs/exec-plan/active/{slug}/plan.md` |
| **ADR** | *Why* an expensive-to-reverse choice exists, only when it truly needs an ADR | Reset state: no `ADR-NNN-*.md` files currently; `docs/decisions/README.md` is the ADR home | humans / agents maintaining docs | `docs/decisions/README.md` |

**The decision pipeline:** `research` (facts I found) → `ADR / owning operational doc` (decision I made) → `plan` (implementation I built).
Research collects evidence; it does **not** decide. ADR is still the name for architectural decision records, but this repo is reset to zero ADR files. Capture only the smallest current rule where future work will naturally look: the ADR README for rare cross-cutting summaries, or the owning rule/API/domain/onboarding/script doc for operational detail.

**ADR writing rule:** do not turn every remembered choice into an ADR. Write the smallest current rule in the surface that will enforce or use it:
- `docs/rules/` for repeatable workflow, code, review, testing, or deployment conventions.
- `docs/api/` for request/response, route, webhook, or integration contracts.
- `docs/domain/` for business semantics, lifecycle states, and data meanings.
- `docs/architecture.md` or onboarding docs for runtime topology and ownership boundaries.
- `docs/decisions/README.md` only for rare ADR-level summaries that help future work discover the owning surface.

**Key principle:** plan != ADR. A plan is archived when its work ends. Any expensive-to-reverse choice made inside a plan is promoted into the ADR README or the owning operational document; the plan entry itself is not replaced.

### Boundary: plan vs ADR

Plans and ADRs answer different questions with different lifespans. Never conflate them.

| | plan (`docs/exec-plan/`) | ADR / owning docs |
|---|---|---|
| Question | *How* to implement this specific work | *Why* this expensive-to-reverse choice — and what alternatives were rejected |
| Scope | One feature / task (work-scoped) | Current conventions that constrain future unrelated work |
| Lifespan | Archivable when work ends | ADR is reset to zero files; add only rare current-state notes |
| Body | Immutable after finalize; scope change → new slug | Short ADR-level note in `docs/decisions/README.md`; operational detail in the owning docs |
| Author | omc-plan / omo / omx agents | humans / agents maintaining docs |
| Location | `docs/exec-plan/active/{slug}/plan.md` → `archive/{slug}/` | `docs/decisions/README.md`, `docs/rules/`, `docs/api/`, `docs/domain/`, onboarding, or script docs |

#### Distill rule

When a plan contains an expensive-to-reverse choice (framework selection, data model, auth strategy, API shape, infrastructure, repository workflow, safety policy), promote that choice into the ADR README or the owning operational document before or at the time the plan is archived.

Ask: "Would a future agent/engineer working on an unrelated feature need to know this decision?"
If yes → update the ADR README or owning operational document. If it only affects this feature's implementation details → leave it in the plan.

When writing ADR-level material, prefer this short shape in the owning doc: `Current rule`, `Why this exists`, `Rejected alternatives`, and `Where enforced`. Skip long history; git keeps old rationale.

#### Do NOT write ADRs for

- Implementation steps or file-level details (those belong in the plan)
- Choices that will be revisited within this same work item
- Trivial configuration values with no architectural consequence
- Rebuilding the deleted ADR archive, retired stubs, or a new name for ADRs

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
     v  plan contained an expensive-to-reverse decision?
     |
promote  -->  docs/decisions/README.md or owning rules/api/domain/onboarding/script doc
```

## Locations

| Store | Role | Git canonical? |
|-------|------|---------------|
| `docs/research/` | Fact collection — findings, sources, comparisons (pre-decision) | Yes |
| `docs/exec-plan/active/{slug}/` | In-progress spec + plan | Yes |
| `docs/exec-plan/archive/{slug}/` | Completed / discarded spec + plan | Yes |
| `docs/decisions/README.md` | ADR home after reset; no `ADR-NNN-*.md` files currently | Yes |
| `docs/rules/` | Standing conventions (ongoing constraints, not work-scoped) | Yes |
| `.omc/specs/` | deep-interview scratch output | No — scratch only |
| `.omc/plans/` | omc tool scratch / drafts | No — scratch only |
| `.omo/plans/` | omo tool scratch / drafts | No — scratch only |
| `.omx/plans/` | omx tool scratch / drafts | No — scratch only |
| `.gjc/specs/` | deep-interview scratch output (gjc) | No — scratch only |
| `.gjc/plans/` | ralplan / gjc tool scratch / drafts | No — scratch only |

## Conventions

- **Product PRD SSOT**: 제품 요구사항의 단일 출처는 Obsidian <vault> vault의 `<prd-path>` 이며, PRD 작업은 Obsidian CLI 대신 이 Markdown 파일 경로에 직접 접근한다.

### Change discipline
- 최소 변경: 목표 달성에 필요한 가장 작은 diff만 만든다 — 인접 리팩터·포맷·스코프 확장 금지.
- 불필요한 주석 금지: 코드로 자명한 것은 주석으로 달지 않고, 스테일·장식 주석은 추가·잔존시키지 않는다.

### E2E verification integrity
- **E2E는 production code path를 실제로 관통해야 한다.** Backend ingest, ML worker, frontend, 외부 연동 등 사용자가 요구한 표면을 검증할 때 stub/fake/mock 서버·레지스트리·탐지기·DB 대체물을 끼워 넣은 실행은 E2E로 부르지 않는다.
- Stub/mock harness는 unit, contract, smoke, local fixture 검증으로만 명명한다. 필요하면 별도 보조 증거로 남길 수 있지만, 최종 E2E acceptance evidence를 대체할 수 없다.
- Production backend ingest를 검증한다고 말하려면 실제 backend process와 실제 persistence side effect를 확인한다. ML RTSP 흐름을 검증한다고 말하려면 worker가 실제 stream consumer 경로와 실제 model/domain pipeline을 지나야 한다.
- **Mock/stub/fake 스크립트는 E2E/acceptance/test-runner로 만들지 않는다.** Test double은 unit/contract test code 안에서만 기본 허용된다. 개발 편의를 위한 synthetic RTSP 입력은 이 repo 안에 MediaMTX/FFmpeg/video-to-RTSP publisher를 만들지 말고, 실제 카메라나 external `SeniorAILab/rtsp-generator`가 노출한 worker-reachable RTSP URL로 공급한다.
- Nursing-home RTSP 검증은 녹화 영상을 external `SeniorAILab/rtsp-generator` 또는 실제 카메라 endpoint로 반복 송출하고 `ml-worker -> ml-api -> backend /ingest/* -> DB side effect`를 확인한다. canned detector, fake backend, in-memory DB, stub ingest는 낙상 탐지 E2E 증거가 아니다.

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

**Enabling GJC repo skill discovery (per checkout).** Discovery is off by default. To call
repo-local skills (e.g. `/skill:technical-report`) from a GJC session, enable it locally
in `.gjc/settings.json` (gitignored — per checkout, not committed):
`{"skills":{"enabled":true,"enableClaudeProject":true}}`. `.claude/skills` symlinks resolve
to `.agents/skills`, so the single source is exposed without duplication. The documentation
workflow uses the external craft-skills `/skill:documents`, not a repo-local copy. Invoke
skills manually on-demand (e.g. update ADR guidance or owning docs with `/skill:documents` when work lands);
no automatic hooks or cron.

### Version control
Branch & worktree, issue labeling, commit, and PR/review/merge are one domain with a single
entry point: **[`docs/rules/version-control.md`](docs/rules/version-control.md)** (hub →
4 facet SSOTs). All rule bodies — branch/worktree invariant, size gate, merge
discipline, lane-pool mode, label taxonomy, commit format, and git-native enforcement — live
in the facet docs, not here.

### Backend architecture lint & guard
백엔드 계층(controller→service→repository)·DTO 경계는 warn-first 내장 ESLint로, 스키마↔마이그레이션 결합 계약은 단일소스 `scripts/backend-guard/`로 강제한다. 상세: `docs/rules/backend-architecture-lint-and-guard.md`. 명령: `pnpm --filter backend run lint`.

### Decision map (cross-reference)
Numbered decision files are retired. Current expensive-to-reverse decisions live in
[`docs/decisions/README.md`](docs/decisions/README.md) or in the owning
rule/API/domain/onboarding/script document. Keep the map short and current; use
git history for old rationale.

### Provider review lanes

This repo may use Claude Code, Codex, and Gemini as complementary advisory review lanes:

- Claude Code/GJC owns orchestration, repo-local context management, subagent delegation, and final integration responsibility.
- Codex is useful for independent candidate/review passes grounded in this `AGENTS.md`, especially placement disagreements and implementation sanity checks.
- Gemini is useful for adversarial or sanity-check review, especially omission risk, stale links, and category-boundary challenges.

No provider is merge authority. Durable rules live in repo docs (`AGENTS.md`, `docs/decisions/README.md`, `docs/rules/`) and final acceptance depends on the validated diff, verification evidence, and human review.
