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
