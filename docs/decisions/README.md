# Architecture Decision Records

Architecture Decision Records (ADRs) capture significant technical choices in this project: the context that forced the decision, the option selected, the alternatives weighed, and the trade-offs accepted. ADRs are the authoritative record of *why* the architecture looks the way it does.

## Lifecycle

```text
Proposed  →  Accepted  →  Superseded
                       →  Partially Superseded
                       →  Deprecated
```

ADRs are the visible current decision corpus, not a landfill for superseded bundles. If a decision changes, write successor ADRs and mark/source-map the old decision. Fully superseded non-MECE source ADR files may be retired from the visible corpus only after this README maps every active clause to successors, live-referenced content is preserved in successor ADRs, and the exact original body remains recoverable from git history.

Numbering memo: PR #104 freezes ADR-022 through ADR-028 for the MECE split. ADR-029 (ml) is the per-site edge-inference deployment topology (signal-only egress); ADR-030 remains reserved for a future serving-predict decision. PR #105 split candidates are ADR-031 through ADR-034. PR #103 alert-pipeline split lands backend ADR-035 through ADR-038. PR #167 size-gate governance lands common ADR-039; PR #167 issue auto-label automation lands common ADR-040. ADR-041 (common) is the port-standardization & Compose dev/prod strategy. ADR-042 through ADR-044 are backend successors for #211 MVP Kakao fan-out. ADR-045 (common) supersedes ADR-028: the Streamlit demo is local-only and the demo access-mode branching is removed. Issue #216 assigns ADR-046 through ADR-049 for API/event contract cleanup: backend REST/layering, canonical ingest cleanup, ML/backend window predict contract, and Prisma naming convention. ADR-050 (ml) supersedes ADR-026 terminology from seam to contract. ADR-055 (frontend) records the Vite React `front/` SSOT migration and partially supersedes ADR-001's frontend-stack choice.
## Category ontology

Active/current-effective ADRs live in exactly one of four top-level categories:

| Category | Meaning |
|---|---|
| [`ml/`](./ml/) | ML project decisions: data, models, training, demo, serving, ML experimentation, and ML-local deployment constraints. |
| [`backend/`](./backend/) | NestJS/backend decisions: API, persistence, alerting, webhook, backend policy, and database integration. |
| [`frontend/`](./frontend/) | Product frontend/dashboard decisions for repository path `front/`. |
| [`common/`](./common/) | Strict common decisions that still constrain at least two of `ml`, `backend`, and `frontend` after attempted split, or repo-wide process/tooling decisions. Not a dumping ground for unclear ownership. |

### Active vs historical semantics

- **Active ADR**: current-effective decision; must be atomic and belong to exactly one category.
- **Partially superseded ADR**: still has active clauses; active clauses must be atomic or split into successors.
- **Retired source ADR**: fully superseded non-atomic source record removed from the visible corpus after successor coverage is proven; recoverable from git history and excluded from active MECE counts.

## Decision index

### Common

| # | Title | Status | Date | Summary |
|---|---|---|---|---|
| [ADR-001](./common/ADR-001-polyglot-monorepo.md) | Polyglot monorepo with per-ecosystem dependency management | Accepted | 2026-06-07 | pnpm workspace (`front` + `backend`) and uv project (`ml`) keep separate lock files; root package is orchestration-only. |
| [ADR-008](./common/ADR-008-issue-driven-worktree-enforcement.md) | Issue-driven worktrees, enforced git-natively | Accepted | 2026-06-09 | One issue → one branch/worktree via `git wt`; POSIX git-guard scripts are the shared enforcement source. |
| [ADR-014](./common/ADR-014-fail-fast-error-policy.md) | Fail-fast error policy | Accepted | 2026-06-10 | Code refuses explicitly instead of silently substituting fake/default results; mechanical rule doc owns deny-list details. |
| [ADR-016](./common/ADR-016-enforcement-timing-principle.md) | Enforcement timing principle | Accepted | 2026-06-10 | Irreversible asset leaks block early; reversible conventions stay audit-tier. |
| [ADR-023](./common/ADR-023-ml-backend-prediction-boundary.md) | ML prediction boundary and backend product-policy ownership | Accepted; extended by ADR-048 | 2026-06-13 | ML returns model signals; backend owns alert policy, persistence, deduplication, rate limits, and side effects. Concrete `/predict(window)` geometry and response fields are fixed by ADR-048. |
| [ADR-024](./common/ADR-024-ml-demo-product-surface-boundary.md) | ML demo surface is not the product frontend | Accepted | 2026-06-13 | `ml/demo/` is an ML observation harness; `front/` is the product UI. |
| [ADR-028](./common/ADR-028-demo-access-boundary.md) | Demo access boundary for private data and public uploads | Superseded by ADR-045 | 2026-06-13 | Superseded: the Streamlit demo is now local-only (ADR-045), so the deploy-time public/operator access boundary is removed. |
| [ADR-039](./common/ADR-039-pr-size-gate-threshold.md) | PR size hard-gate threshold — logic churn > 1000 | Accepted | 2026-06-16 | Relaxes the `pr-check.yml` hard-fail from logic churn >500 to >1000, keeping it logic-based/hard with `size/override`; markdown/docs/tests/lock stay non-logic and free from the gate (issue #167). |
| [ADR-040](./common/ADR-040-issue-type-autolabel.md) | Issue Type auto-label — fail-closed mapping to `type:` | Accepted | 2026-06-16 | `issue-auto-label.yml` maps the issue form Type to exactly one `type:` label (fail-closed, no `feat` fallback, preserves non-type labels); closes the `git wt` branch-type gap (issue #167). |
| [ADR-041](./common/ADR-041-port-standardization-compose-strategy.md) | Port standardization and Compose dev/prod strategy | Accepted | 2026-06-16 | Standardizes front/backend/ML/db ports, native daily development, three-file Compose topology, root-context Docker builds, and browser-vs-service-name URL boundaries. |
| [ADR-045](./common/ADR-045-streamlit-demo-local-only.md) | Streamlit demo is local-only — demo access-mode branching removed | Accepted | 2026-06-18 | Supersedes ADR-028: the demo is a local operator tool with no external surface; `FALL_DEMO_MODE` public/operator branching is removed and data custody is owned by ADR-018. |
| [ADR-048](./common/ADR-048-ml-backend-window-predict-contract.md) | ML/backend window predict contract | Accepted | 2026-06-18 | Extends ADR-023 with the concrete ML `/predict` contract: backend sends `[T][51]` pose windows, ML extracts 45-dim features and returns `{fall_probability, operating_threshold, is_fall}`, backend owns policy. |

### Backend

| # | Title | Status | Date | Summary |
|---|---|---|---|---|
| [ADR-002](./backend/ADR-002-postgres-everywhere.md) | PostgreSQL everywhere | Accepted | 2026-06-07 | Prisma provider is not runtime-swappable; dev and prod both use PostgreSQL with environment-specific URLs. |
| [ADR-031](./backend/ADR-031-prisma-domain-model.md) | Prisma domain model (org, auth, resident, camera, alert, status) + RLS foundation | Accepted | 2026-06-16 | #105-1 fan-out: multi-tenant Prisma schema with org-scoped RLS as the data foundation (PR #105 split, issue #102). |
| [ADR-032](./backend/ADR-032-b2b-facility-multitenancy-rls.md) | B2B facility multitenancy — Postgres RLS default-deny + orgId scoping | Accepted | 2026-06-13 | Default-deny row-level security with org-scoped tenant isolation enforced at the DB via the `fall_app` role (PR #105 split, issue #102). |
| [ADR-033](./backend/ADR-033-kakao-oauth-auth-boundary.md) | Kakao OAuth authentication boundary — backend-owned callback, single httpOnly session JWT | Accepted | 2026-06-13 | Backend owns the OAuth callback and issues one httpOnly session JWT; no tokens reach the browser (PR #105 split, issue #102). |
| [ADR-034](./backend/ADR-034-sse-realtime-transport.md) | SSE realtime transport — read-only cookie-auth push with alertSeq replay | Accepted | 2026-06-13 | Read-only SSE push authenticated by the `app_session` cookie with `alertSeq` replay (PR #105 split, issue #102). |
| [ADR-035](./backend/ADR-035-backend-orchestrated-alert-api-architecture.md) | Backend-orchestrated alert API architecture | Accepted; `/api.alerts/events` ingress superseded by ADR-047 | 2026-06-13 | Backend owns alert policy/idempotency/persistence/dispatch and consumes `/predict` signal only; ADR-047 supersedes the separate trusted `POST /api.alerts/events` ingress, leaving `/ingest/alerts` as the only live alert ingress. |
| [ADR-036](./backend/ADR-036-nest-domain-bounded-alerts-layering.md) | Nest domain-bounded layering for alerts | Accepted | 2026-06-13 | `AlertsModule` with thin controller, policy service, repository, ports, and adapters — layering justified by domain/side-effect seams, not global folders (PR #103 split, issue #29). |
| [ADR-037](./backend/ADR-037-alert-event-delivery-outbox-model.md) | Postgres alert event + delivery outbox model | Accepted | 2026-06-13 | `AlertEvent`/`DeliveryAttempt` outbox keyed by `(source_id, external_event_id)` for idempotency + transactional dispatch state; non-tenant tables outside the RLS guard (PR #103 split, issue #29). |
| [ADR-038](./backend/ADR-038-channel-port-kakao-send-to-me-pilot.md) | ChannelPort with Kakao send-to-me pilot, AlimTalk-ready | Accepted | 2026-06-13 | Provider-neutral `ChannelPort` with transient vs terminal_operator_action result semantics; Kakao send-to-me as a pilot adapter reading `KAKAO_TOKEN_PATH` (PR #103 split, issue #29). |
| [ADR-042](./backend/ADR-042-kakao-per-user-token-encrypted-storage.md) | Kakao per-user token encrypted storage | Accepted | 2026-06-17 | Extends ADR-033 by keeping Kakao tokens out of the browser while storing per-user send-to-me access tokens encrypted with AES-256-GCM for backend fan-out. |
| [ADR-043](./backend/ADR-043-canonical-ingest-single-ingress.md) | Canonical ingest single ingress for alert read-model and outbox | Accepted; pilot clause superseded by ADR-047 | 2026-06-17 | Extends ADR-035/037 by making `/ingest/alerts` create both the RLS Alert/SSE read-model and the AlertEvent/per-recipient DeliveryAttempt outbox for one idempotent event; ADR-047 removes the temporary `/api.alerts/events` pilot ingress. |
| [ADR-044](./backend/ADR-044-send-to-me-multi-recipient-fanout.md) | Kakao send-to-me multi-recipient fan-out | Accepted | 2026-06-17 | Extends ADR-038 by defining fan-out as token-bearing OAuth'd Users in the camera org, with independent per-recipient DeliveryAttempt rows. |
| [ADR-046](./backend/ADR-046-rest-api-and-layering-convention.md) | REST API and layering convention | Accepted | 2026-06-18 | Establishes slash-separated REST paths plus controller/service/repository/DTO/adapter/presenter responsibilities, with docs/rules carrying mechanical details. |
| [ADR-047](./backend/ADR-047-canonical-ingest-single-ingress-cleanup.md) | Canonical ingest single ingress cleanup | Accepted | 2026-06-18 | Supersedes ADR-035's separate ingress and ADR-043's pilot clause: `/ingest/alerts` is the only live alert ingress, and `/api.alerts/events` is removed from the live contract. |
| [ADR-049](./backend/ADR-049-prisma-column-naming-convention.md) | Prisma column naming convention | Accepted | 2026-06-18 | Prisma model fields stay camelCase while database tables/columns stay snake_case via `@map` and `@@map` across backend tables. |
| [ADR-051](./backend/ADR-051-kakao-oauth-scope-env-minimal-permission.md) | Kakao OAuth scope env-driven, minimal `talk_message` default | Accepted | 2026-06-18 | Extends ADR-033: `KAKAO_SCOPES` env (default `talk_message`); `profile_nickname` becomes opt-in, removing `invalid_scope` from missing nickname consent (issue #226). |
| [ADR-052](./backend/ADR-052-kakao-alert-message-dto-korean-rich-text.md) | Kakao fall-alert message built from a DTO into Korean rich text | Accepted | 2026-06-18 | Extends ADR-038: the alert message is assembled from a typed DTO (resident/room/time) into Korean rich text for Kakao send-to-me (issue #226). |
| [ADR-053](./backend/ADR-053-kakao-registered-user-recipient-model.md) | Kakao alerts deliver to registered-user send-to-me recipients | Accepted | 2026-06-18 | Extends ADR-044: recipients are token-bearing registered Users in the camera org via per-user send-to-me (issue #226). |

### Frontend

| # | Title | Status | Date | Summary |
|---|---|---|---|---|
| [ADR-055](./frontend/ADR-055-vite-react-front-stack.md) | Vite React front stack as `front/` SSOT | Proposed | 2026-06-20 | Makes the migrated Vite 5 + React 18 dashboard the canonical `front/` implementation, keeps port 3000, and partially supersedes ADR-001's Next.js frontend-stack choice while deferring backend matching to Phase 2. |

### ML

| # | Title | Status | Date | Summary |
|---|---|---|---|---|
| [ADR-006](./ml/ADR-006-frame-source-intake-in-ml-util.md) | Frame-source intake in `ml/util/` | Accepted | 2026-06-09 | `FrameSource` intake lives in `ml/util/` so demo/serving reuse one frame source without `demo` dependency. |
| [ADR-009](./ml/ADR-009-fall-classification-strategy.md) | Fall-classification strategy | Accepted | 2026-06-09 | Bbox geometry rejected; temporal models over COCO-17 keypoint sequences and public datasets first. |
| [ADR-010](./ml/ADR-010-realtime-live-inference-demo-mode.md) | Real-time per-frame live inference demo mode | Accepted | 2026-06-09 | Demo observes inference frame-by-frame rather than pre-rendering annotated clips. |
| [ADR-011](./ml/ADR-011-live-camera-intake-and-multipage-demo.md) | Live camera intake as a second `FrameSource` | Accepted | 2026-06-10 | `CameraSource` joins `VideoFileSource`; live camera page stays separate from file playback page. |
| [ADR-012](./ml/ADR-012-ml-data-domain-first-layout.md) | Domain-first two-tier layout for `ml/data/` | Accepted; access boundary superseded (ADR-028 → ADR-045) | 2026-06-10 | `ml/data/{domain}/{raw,processed,poses,annotated}` plus top-level `eval/` and `uploads/`; access boundary extracted to ADR-028, now superseded by ADR-045 (demo local-only). |
| [ADR-013](./ml/ADR-013-le2i-training-pipeline-decisions.md) | Le2i training-pipeline decisions | Accepted | 2026-06-10 | Le2i dataset, window geometry, recall-first threshold, and gold-clip secondary evaluation. |
| [ADR-015](./ml/ADR-015-ml-models-single-root.md) | `ml/models/` single root | Accepted | 2026-06-10 | Consolidates pose weights, trained fall models, and comparison checkpoints under `ml/models/`. |
| [ADR-017](./ml/ADR-017-fall-model-adoption-criteria.md) | Fall-model adoption criteria | Accepted | 2026-06-10 | Precision@recall≥0.90, NH zero-tolerance gate, and hard disqualifiers for recall/latency. |
| [ADR-018](./ml/ADR-018-cross-machine-dataset-custody.md) | Cross-machine dataset custody and sync | Accepted | 2026-06-11 | m3-pro owns source footage; one-way staged sync keeps footage/weights out of Git and cloud. |
| [ADR-019](./ml/ADR-019-nh-gold-dataset-construction.md) | Nursing-home gold dataset construction methodology | Accepted | 2026-06-12 | Processed-clip frame labels, proposed/confirmed authority split, correction history, eval-only corpus. |
| [ADR-020](./ml/ADR-020-autoresearch-loop-method.md) | Autoresearch loop method | Accepted | 2026-06-12 | Deterministic config-addressed runs, env-var HP channel, wave protocol, artifact restore, human policy queue. |
| [ADR-021](./ml/ADR-021-demo-cloud-deployment-deferred.md) | Demo cloud deployment deferred | Accepted | 2026-06-12 | CPU-only cloud hosting rejected for real-time demo; GPU hosting deferred and deploy artifacts retained. |
| [ADR-022](./ml/ADR-022-ml-serving-training-lifecycle.md) | ML serving and training lifecycle boundary | Accepted | 2026-06-13 | Extracted active ML lifecycle and dependency-group boundary from retired source ADR-003. |
| [ADR-025](./ml/ADR-025-yolo26-pose-framework-adoption.md) | YOLO26-pose framework adoption | Accepted | 2026-06-13 | Extracted pose framework adoption and domain-fit caveats from retired source ADR-005. |
| [ADR-026](./ml/ADR-026-frame-model-seam-architecture.md) | Frame and model seam architecture | Superseded by ADR-050 (terminology: seam→contract) | 2026-06-13 | Historical seam terminology record; active contract architecture vocabulary is ADR-050. |
| [ADR-027](./ml/ADR-027-inference-output-baseline-policy.md) | Inference output axis and comparison baseline policy | Accepted | 2026-06-13 | Extracted output-axis semantics, real baseline retention, and fake-adapter rejection from retired source ADR-005. |
| [ADR-029](./ml/ADR-029-edge-inference-deployment-topology.md) | Per-site edge inference with signal-only egress | Accepted | 2026-06-19 | Pose→classification runs on a per-site edge device that also emits; only signed events (kB) leave the site, never raw video. Complements ADR-023/048; backend-pull is the dormant retained seam. |
| [ADR-050](./ml/ADR-050-frame-model-contract-architecture.md) | Frame and model contract architecture | Accepted | 2026-06-18 | Supersedes ADR-026 terminology: `FrameSource` is the stream contract and `ModelModule.predict(frame) -> DetectionResult` is the model contract. |
| [ADR-054](./ml/ADR-054-bed-localization-instance-segmentation.md) | Bed localization via COCO instance segmentation | Accepted | 2026-06-18 | Replaces bbox-only bed detection with `yolo26m-seg` masks (class 59); `BoundingBox.polygon` carries the silhouette for shape-accurate rendering, bbox derived for bed-exit; no hard cap (issue #243/#244). |

### Retired source ADRs

These IDs are intentionally absent from visible category folders after the split. They are not active authorities, and they are not renumbered. The exact original source bodies remain recoverable from git history; the coverage matrix below maps each retired source decision to current active successors.

| # | Former title | Why retired | Active replacements |
|---|---|---|---|
| ADR-003 | ML serving/training lifecycle split and responsibility boundary | Non-MECE bundle split into lifecycle, model path, ML/backend boundary, and demo/product boundary authorities | ADR-015, ADR-022, ADR-023, ADR-024 |
| ADR-004 | Relocate video data from `assets/` to `ml/data/` | Fully represented by the current domain-first data layout authority | ADR-012 |
| ADR-005 | YOLO26-pose stack and two-seam module architecture | Non-MECE bundle split into framework, contract architecture, and output/baseline authorities | ADR-025, ADR-050, ADR-027 |
| ADR-007 | `ml/` local filesystem layout | Fully represented by current data/model layout authorities | ADR-012, ADR-015 |

## Coverage matrix for ADR MECE reorganization

Counts for the original MECE reorganization, plus ADR-050 terminology supersession:

- Existing ADRs audited: 21 (`ADR-001` through `ADR-021`).
- Every existing identifier accounted for: 21/21.
- Visible original ADR files retained: 17/21.
- Retired source ADR files: 4 (`ADR-003`, `ADR-004`, `ADR-005`, `ADR-007`).
- New successors created: 7 (`ADR-022` through `ADR-028`).
- Visible ADR files after the original reorganization: 24 (17 retained originals + 7 successors); ID gaps are intentional and not renumbered.
- ADR-050 follow-up: +1 visible ML ADR; ADR-026 remains visible as historical terminology source, while active stream/model contract terminology moves to ADR-050.
- Retired source ADRs excluded from active MECE validation: 4 (`ADR-003`, `ADR-004`, `ADR-005`, `ADR-007`).
- Superseded active terminology source: 1 (`ADR-026`).
- Partially superseded active source: 1 (`ADR-012`).

| ADR id | Title | Original path | New physical path | Original status | Resulting status | Role | Extracted atomic decision(s) | Split required | Active replacement ADRs | Final category | `common/` rationale | No-omission checks | Supersession link check | Relative link check | Reviewer notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ADR-001 | Polyglot monorepo | `docs/decisions/ADR-001-polyglot-monorepo.md` | `docs/decisions/common/ADR-001-polyglot-monorepo.md` | Accepted | Accepted | active | One repo with per-ecosystem lock/dependency boundaries | no | — | common | Constrains `front`, `backend`, `ml`, and root orchestration together | Context/Decision/Alternatives/Consequences/Evidence preserved in moved file | unchanged | category path updated | Strict common gate passes |
| ADR-002 | PostgreSQL everywhere | `docs/decisions/ADR-002-postgres-everywhere.md` | `docs/decisions/backend/ADR-002-postgres-everywhere.md` | Accepted | Accepted | active | PostgreSQL provider parity for Prisma/backend | no | — | backend | — | Context/Decision/Alternatives/Consequences/Evidence preserved in moved file | unchanged | category path updated | Backend-local |
| ADR-003 | ML serving/training split | `docs/decisions/ADR-003-ml-serving-training-split.md` | Retired from visible corpus; recover from git history | Accepted; partially superseded by ADR-015 | Retired after supersession | retired-source | Lifecycle boundary; ML/backend prediction boundary; demo/product boundary; old artifact path | yes | ADR-015, ADR-022, ADR-023, ADR-024 | not visible; active successors in ml/common | common successors ADR-023/024 carry gate rationale | Source body recoverable from git history; active clauses represented by successors | successor status clauses reference retired source id | no live markdown link to removed file | Visible corpus stays MECE; no source file retained |
| ADR-004 | Relocate video data | `docs/decisions/ADR-004-relocate-video-data-to-ml-data.md` | Retired from visible corpus; recover from git history | Accepted; partially superseded by ADR-012 | Retired after supersession | retired-source | Original `assets/`→`ml/data/` relocation; raw/gitignore invariants inherited by ADR-012 | no new successor | ADR-012 | not visible; active successor in ml | — | Source body recoverable from git history; current active layout represented by ADR-012 | successor status references retired source id | no live markdown link to removed file | Historical lineage retained by matrix + git history |
| ADR-005 | YOLO26-pose and seams | `docs/decisions/ADR-005-yolo26-pose-and-module-seam.md` | Retired from visible corpus; recover from git history | Accepted; partially verified | Retired after supersession | retired-source | Pose framework; contract architecture; output/baseline policy | yes | ADR-025, ADR-050, ADR-027 | not visible; active successors in ml | — | Verification table and figures are now live-preserved in ADR-025, including Room 502 25% and Room 301 51.3%; active clauses and verification evidence represented by successors | successor status clauses reference retired source id; ADR-050 supersedes ADR-026 terminology only | no live markdown link to removed file | Visible corpus stays MECE; no source file retained |
| ADR-006 | Frame-source intake | `docs/decisions/ADR-006-frame-source-intake-in-ml-util.md` | `docs/decisions/ml/ADR-006-frame-source-intake-in-ml-util.md` | Accepted | Accepted | active | `FrameSource` intake placement in `ml/util/` | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Atomic ML placement |
| ADR-007 | ML local filesystem layout | `docs/decisions/ADR-007-ml-local-filesystem-layout.md` | Retired from visible corpus; recover from git history | Accepted; partially superseded by ADR-012 and ADR-015 | Retired after supersession | retired-source | Legacy weight/output layout | no new successor | ADR-012, ADR-015 | not visible; active successors in ml | — | Source body recoverable from git history; active paths represented by ADR-012/015 | successor status references retired source id | no live markdown link to removed file | Historical source retained by matrix + git history |
| ADR-008 | Issue-driven worktrees | `docs/decisions/ADR-008-issue-driven-worktree-enforcement.md` | `docs/decisions/common/ADR-008-issue-driven-worktree-enforcement.md` | Accepted; complemented by ADR-016 | Accepted | active | One issue→branch→worktree; git-native shared enforcement location | no | — | common | Governs all repo actors/surfaces, not one ecosystem | Context/Decision/Alternatives/Consequences/Evidence preserved | complement unchanged | category path updated | Strict common gate passes |
| ADR-009 | Fall-classification strategy | `docs/decisions/ADR-009-fall-classification-strategy.md` | `docs/decisions/ml/ADR-009-fall-classification-strategy.md` | Accepted | Accepted | active | Temporal keypoint model strategy/public dataset path/gold baseline | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Coherent ML strategy bundle |
| ADR-010 | Real-time live inference demo mode | `docs/decisions/ADR-010-realtime-live-inference-demo-mode.md` | `docs/decisions/ml/ADR-010-realtime-live-inference-demo-mode.md` | Accepted | Accepted | active | Standard ML demo observation mode | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Atomic demo-mode decision |
| ADR-011 | Live camera intake | `docs/decisions/ADR-011-live-camera-intake-and-multipage-demo.md` | `docs/decisions/ml/ADR-011-live-camera-intake-and-multipage-demo.md` | Accepted | Accepted | active | First live-camera `FrameSource` decision, including page/selection consequences | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Audited as no-split: one first-live-source decision |
| ADR-012 | ML data domain-first layout | `docs/decisions/ADR-012-ml-data-domain-first-layout.md` | `docs/decisions/ml/ADR-012-ml-data-domain-first-layout.md` | Accepted; partially supersedes retired source ADR-004/007 | Accepted; partially superseded by ADR-028 | active + partially superseded | ML data layout; access boundary extracted | yes | ADR-028 for access boundary | ml active source | ADR-028 carries common gate | Original body preserved; active access clause represented by ADR-028 | status links ADR-028 and ADR-016 | category links updated | Layout remains active in ADR-012 |
| ADR-013 | Le2i training decisions | `docs/decisions/ADR-013-le2i-training-pipeline-decisions.md` | `docs/decisions/ml/ADR-013-le2i-training-pipeline-decisions.md` | Accepted | Accepted | active | Le2i dataset/window/threshold/gold-eval training contract | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Coherent training contract |
| ADR-014 | Fail-fast error policy | `docs/decisions/ADR-014-fail-fast-error-policy.md` | `docs/decisions/common/ADR-014-fail-fast-error-policy.md` | Accepted | Accepted | active | Cross-runtime fail-fast/refusal policy | no | — | common | Constrains ml/backend/front and shared tooling | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Strict common gate passes |
| ADR-015 | ML models single root | `docs/decisions/ADR-015-ml-models-single-root.md` | `docs/decisions/ml/ADR-015-ml-models-single-root.md` | Accepted; partially supersedes retired source ADR-003/007 | Accepted | active | `ml/models/` root and metadata contract | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Current model-path authority |
| ADR-016 | Enforcement timing principle | `docs/decisions/ADR-016-enforcement-timing-principle.md` | `docs/decisions/common/ADR-016-enforcement-timing-principle.md` | Accepted; complements ADR-008; resolves ADR-012 deferral | Accepted | active | Reversibility-based enforcement timing | no | — | common | Governs hooks, agents, git policy, and tests across surfaces | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Strict common gate passes |
| ADR-017 | Fall-model adoption criteria | `docs/decisions/ADR-017-fall-model-adoption-criteria.md` | `docs/decisions/ml/ADR-017-fall-model-adoption-criteria.md` | Accepted | Accepted | active | Automated model adoption gates | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Atomic adoption rule bundle |
| ADR-018 | Cross-machine dataset custody | `docs/decisions/ADR-018-cross-machine-dataset-custody.md` | `docs/decisions/ml/ADR-018-cross-machine-dataset-custody.md` | Accepted | Accepted | active | m3/m1 dataset custody and staging sync | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | ML data custody |
| ADR-019 | NH gold dataset construction | `docs/decisions/ADR-019-nh-gold-dataset-construction.md` | `docs/decisions/ml/ADR-019-nh-gold-dataset-construction.md` | Accepted | Accepted | active | Processed-clip labels and human confirmation methodology | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | ML evaluation corpus |
| ADR-020 | Autoresearch loop method | `docs/decisions/ADR-020-autoresearch-loop-method.md` | `docs/decisions/ml/ADR-020-autoresearch-loop-method.md` | Accepted | Accepted | active | Reproducible unattended ML experiment protocol | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Audited as no-split: one protocol bundle |
| ADR-021 | Demo cloud deployment deferred | `docs/decisions/ADR-021-demo-cloud-deployment-deferred.md` | `docs/decisions/ml/ADR-021-demo-cloud-deployment-deferred.md` | Accepted | Accepted | active | CPU-only hosted ML demo rejected; GPU deferred | no | — | ml | — | Context/Decision/Alternatives/Consequences/Evidence preserved | unchanged | category path updated | Audited as no-split: one hardware-target decision |
| ADR-026 | Frame and model seam architecture | `docs/decisions/ml/ADR-026-frame-model-seam-architecture.md` | `docs/decisions/ml/ADR-026-frame-model-seam-architecture.md` | Accepted | Superseded by ADR-050 terminology | historical active-source | Stream/model architecture under retired `seam` vocabulary | no | ADR-050 for active terminology | ml historical source | — | Body intentionally preserved; status points to terminology successor | status links ADR-050 | unchanged | Historical record retained; do not rewrite body |
| ADR-050 | Frame and model contract architecture | — | `docs/decisions/ml/ADR-050-frame-model-contract-architecture.md` | — | Accepted | active | Stream contract (`FrameSource`) and model contract (`ModelModule.predict(frame) -> DetectionResult`) terminology successor | no | — | ml | — | Carries ADR-026 architecture forward with only seam→contract terminology change | supersedes ADR-026 terminology | category path valid | Active contract terminology authority |

## Provider review stance

Claude Code, Codex, and Gemini may be used as advisory review lanes for ADR placement, omission checks, link validation, and common-gate challenges. No provider is merge authority. Final authority is this coverage matrix, validated links/diff, and human review.
