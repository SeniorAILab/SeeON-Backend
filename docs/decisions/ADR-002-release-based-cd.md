---
slug: ADR-002-release-based-cd
date: 2026-07-12
status: Accepted
supersedes: ADR-001-iwinv-jenkins-cd
references:
  - SeniorAILab/eldercare-fall-ai#587
---

# ADR-002: Release-based CD

## Status

Accepted. Supersedes ADR-001.

## Context

The previous pipeline treated a successful main CI result as a production deploy
request. That couples merge cadence to production cadence and leaves stale
run-completion and SHA forwarding logic in the GitHub-to-Jenkins boundary.
Production needs an explicit release decision while retaining Jenkins as the
host-side builder and deployer.

## Decision

A manually published production GitHub Release is the only normal production
trigger. `pnpm release:prod -- vX.Y.Z` creates a strict production semantic
version release from `main`; publishing it starts the Jenkins deployment path.

The GitHub workflow classifies a published canonical non-draft, non-prerelease
production release and sends Jenkins an empty signal. Jenkins uses its existing
deploy key to resolve release state with one `git ls-remote` lookup, producing
`RELEASE_TAG=`, `RELEASE_SHA=`, and `NO_OP=`. The resolved tagged commit must be
contained by `origin/main`. Backend and frontend images are named only with the
resolved commit SHA.

Repeated delivery of the same version, or a version lower than the deployed
semantic version, converges as a successful no-op. It does not build or deploy.
Rollback remains the explicit `iwinv-deploy.sh --rollback` operation.

## Drivers

- Separate merge, release, and deployment concerns.
- Let operators control the production deployment moment without changing the
  GitOps pull model on the host.
- Keep release provenance in Git while preserving Jenkins as the sole
  server-side image builder and deploy executor.

## Alternatives considered

### Keep true CD from successful main CI

Rejected. It makes every eligible merge a production deployment and retains
stale CI completion and SHA forwarding machinery.

### Use a PAT and GitHub REST API from Jenkins

Rejected. It adds a broad personal credential and a mutable API dependency where
the deploy key and Git remote already provide the required immutable resolution.

### Send `tag_name` with the webhook

Rejected. It duplicates release identity across the webhook and remote state,
creating disagreement and replay handling concerns. Jenkins resolves the
canonical state once instead.

### Run both triggers during a two-stage coexistence period

Rejected. Parallel triggers create duplicate deployment authority and make
convergence behavior harder to reason about. Cutover is atomic at the trigger
boundary.

## Why chosen

Release publication makes the deployment decision visible and auditable, while
the empty signal keeps GitHub from becoming a second deployment-state source.
Jenkins pulls and verifies the release state through its existing Git credential,
so the deployer acts on repository truth rather than payload data.

## Consequences

- Production cadence is explicitly manual at release issuance time.
- Stale CI completion, SHA forwarding, and branch-filter logic is unnecessary
  and is removed.
- The `DEPLOY_ENABLED` cutover interlock was removed at cutover completion;
  publishing a production release is the only deployment gate.
- Operators must publish valid production semantic version releases for normal
  production deployments.

## Follow-ups

- Remove obsolete Jenkins parameters after cutover housekeeping.
- Track public transport hardening in issue #587.
