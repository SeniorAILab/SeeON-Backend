# Decision Index

This directory is the destination for decision records only when the user explicitly asks for ADRs
or durable decision documentation. `init` creates no ADR files and requires no ADR lifecycle.

Both records below were originally decided in the pre-extraction combined
repository (`SeniorAILab/eldercare-fall-ai`, backend + frontend) and are
preserved as decided. Current deploy ownership belongs to
`SeniorAILab/SeeON-Backend`: ADR-002, as amended at extraction, governs the
backend + API-ingress release-based CD; ADR-001's frontend scope is historical.

## Explicit Records

| ADR | Title | Status | Date |
|-----|-------|--------|------|
| [ADR-001](./ADR-001-iwinv-jenkins-cd.md) | iwinv 서버의 Jenkins 기반 CD 파이프라인 (front + backend) | Superseded by ADR-002 (pre-extraction, historical) | 2026-07-10 |
| [ADR-002](./ADR-002-release-based-cd.md) | Release-based CD | Accepted (current; amended for backend-only extraction) | 2026-07-12 |
