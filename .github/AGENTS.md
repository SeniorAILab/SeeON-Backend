# GitHub agent rules — CI and Jenkins release trigger

## Overview
`.github/**` owns GitHub-side CI, PR automation, and the gated release signal for
iwinv Jenkins CD. Jenkins, not GitHub Actions, builds and deploys backend/frontend.

## Where to look
- `workflows/ci.yml` — CI jobs.
- `workflows/pr-check.yml` — PR policy.
- `workflows/deploy-iwinv.yml` — published-release signal to Jenkins.

## Invariants
- The deployment workflow handles only a published production release. The
  `classify` job accepts a non-draft non-prerelease release with a strict
  `vMAJOR.MINOR.PATCH` tag; canonical repository identity and webhook secrets
  are gated by the downstream `trigger` job, not by the classifier.
- After classification, GitHub Actions sends Jenkins an intentionally empty
  signal. Jenkins resolves the release tag and commit exactly once with the
  existing deploy-key authenticated `git ls-remote` lookup; Actions does not
  supply a SHA or ref.
- GitHub Actions sends the webhook using `Authorization: Bearer` and repository
  secret `WEBHOOK_TOKEN`. Jenkins stores the matching server credential as
  `eldercare-webhook-token`; never expose either value.
- GitHub Actions does not build, tag, push, SSH-deploy, retry, or roll back
  production images. Jenkins alone builds exact
  `eldercare-backend:<sha>`/`eldercare-front:<sha>` images and deploys them.
- Keep permissions minimal and fail before an external trigger when required
  release classification input is absent.
- The trigger gate is classification plus canonical repository identity; no
  additional enablement variable exists.

## Anti-patterns
- No GHCR, `latest`, fallback ref/image/env, or automatic retry/rollback path.
- No deployment of ML services or ML images; ML remains edge-only.
- No broad `write-all` permissions or logging of tokens, credentials, or env data.