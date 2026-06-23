# GitHub agent rules - workflows, issue forms, and repository automation

## Overview
`.github/**` owns GitHub-side automation only: CI, PR checks, labels, and the
Naver Cloud deploy trigger.

## Where to look
- `workflows/ci.yml` - advisory CI jobs; local pre-push remains the real gate.
- `workflows/pr-check.yml` - PR size/base/draft policy checks.
- `workflows/deploy-ncloud.yml` - builds GHCR images and deploys the VM.
- `ISSUE_TEMPLATE/task.yml` and `workflows/issue-auto-label.yml` - issue type
  routing.

## Conventions
- Keep workflow permissions minimal per job. Raise scopes only for the job that
  needs them.
- Production deploy runs only when a non-prerelease GitHub Release is published,
  or through explicit `workflow_dispatch` with a concrete ref.
- Prefer `pnpm release:prod -- vX.Y.Z` for production release creation so the
  release target and tag format stay consistent.
- Normal production deploy images are built in GitHub Actions and pushed to GHCR
  with the exact commit SHA tag.
- If Actions quota prevents image builds, use the documented local manual path
  (`pnpm deploy:prod:manual -- <release-or-sha>`) instead of adding workflow
  fallback logic.
- Workflow inputs and secrets must fail validation before SSH starts. Do not
  echo private keys, tokens, `.env` content, or passwords.
- Advisory checks still matter: never treat a pending or red `ci-gate` as safe
  to merge.

## Anti-patterns
- No implicit `latest` image tag in production deploys.
- No production deploy triggered by ordinary `main` merges.
- No VM-side backend/front image builds from workflow changes.
- No fallback branch, fallback image, or fallback environment when a deploy
  input is missing.
- No automatic deploy retry, rollback, or alternate path that hides the first
  failure. Retry is a manual operator decision after diagnosis.
- No broad `write-all` workflow permissions for convenience.
