# Architecture Decision Records

An Architecture Decision Record (ADR) captures a significant technical choice made in this project — the context that forced the decision, the option selected, the alternatives weighed, and the trade-offs accepted. ADRs are the authoritative record of *why* the architecture looks the way it does, not just *what* it looks like.

## Lifecycle

```
Proposed  →  Accepted  →  Superseded
                       →  Deprecated
```

A decision moves from **Proposed** (drafted, under review) to **Accepted** (ratified and in effect) once the team agrees. If circumstances change and a new decision overrides an existing one, the old ADR is marked **Superseded** (with a reference to its successor) — it is never deleted. Removing an ADR would erase the reasoning trail; supersession preserves it. **Deprecated** is used when a decision is retired without a direct replacement (e.g., a component is removed).

> **Rule: never delete, always supersede.** Future readers need the historical chain to understand how the system evolved and why dead-end paths were rejected.

---

## Decision Index

| # | Title | Status | Date | Summary |
|---|-------|--------|------|---------|
| [ADR-001](./ADR-001-polyglot-monorepo.md) | Polyglot monorepo with per-ecosystem dependency management | Accepted | 2026-06-07 | pnpm workspace (front + backend) and uv project (ml) maintain separate lock files; the root `package.json` is an orchestration-only shell with no application dependencies. |
| [ADR-002](./ADR-002-postgres-everywhere.md) | PostgreSQL everywhere (dev/prod parity via DATABASE_URL) | Accepted | 2026-06-07 | Prisma's provider is baked into generated migrations, making SQLite-to-Postgres swaps unsafe at runtime; Docker Compose provides a local Postgres instance so dev and prod share a single provider and only differ by `DATABASE_URL`. |
| [ADR-003](./ADR-003-ml-serving-training-split.md) | ML serving/training lifecycle split + version-addressed artifacts | Accepted | 2026-06-07 | FastAPI serving and model training are treated as separate lifecycle concerns; artifacts are addressed as `ml/artifacts/<model-name>/<version>/` (Triton-inspired layout) so serving code can load a pinned version without touching training infrastructure. |
| [ADR-004](./ADR-004-relocate-video-data-to-ml-data.md) | Relocate video data from assets/ to ml/data/ | Accepted | 2026-06-07 | Introducing `ml/` as the Python uv project that owns data processing makes `assets/` the wrong home for training footage; `ml/data/{raw,processed}` collocates data with the code that consumes it and keeps the `fall-video-crop-rename` skill paths coherent. |
| [ADR-005](./ADR-005-yolo26-pose-and-module-seam.md) | YOLO26-pose stack + two-seam module architecture | Accepted | 2026-06-08 | MediaPipe→Ultralytics YOLO26-pose (domain-fit partially verified); a `FrameSource` stream-seam unifies file + live stream and a `ModelModule.predict(frame)→DetectionResult` model-seam makes models pluggable. Complements ADR-003. |
| [ADR-006](./ADR-006-frame-source-intake-in-ml-util.md) | Frame-source intake in `ml/util/` | Accepted | 2026-06-09 | The stream-seam intake moves to `ml/util/` so serving/realtime reuse one frame-intake without depending on `demo/` (strict `demo → util`, guard-tested). Model-seam, playback, and overlay stay in `demo/` (YAGNI). References ADR-005. |
| [ADR-007](./ADR-007-ml-local-filesystem-layout.md) | `ml/` local filesystem layout — weight cache + derived outputs | Accepted | 2026-06-09 | Two gaps no prior ADR owned: upstream pose weights cache to `ml/weights/` (ephemeral, re-downloadable) instead of the project root; generated outputs live under `ml/data/` output-role subdirs (`annotated/`, reserved `eval/`). MECE vs ADR-003/004/005/006 via permanence + data-role-by-subdir discriminators. Complements ADR-004. |
| [ADR-008](./ADR-008-issue-driven-worktree-enforcement.md) | Issue-driven worktrees, enforced git-natively from one source of truth | Accepted | 2026-06-09 | One issue → one branch `<type>/<issue#>-<slug>` → one worktree. Enforcement is git-native (`core.hooksPath` → `.githooks/`) backed by single-source POSIX scripts in `scripts/git-guard/` that every layer (git hooks, Claude, Codex) invokes — identical behavior by construction. Protected-branch commits/pushes refused; stale push blocked, stale commit warns; `git wt` alias as front door; `GIT_GUARD_PROTECTED=` escape hatch. Rejected husky (Node-coupled), agent-only (bypassable), remote-only (too late). |
