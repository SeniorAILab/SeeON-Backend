# GitHub agent rules — CI and Jenkins CD trigger

## Overview
`.github/**` owns GitHub-side CI, PR automation, and the gated trigger for iwinv
Jenkins CD. Jenkins, not GitHub Actions, builds and deploys backend/frontend.

## Where to look
- `workflows/ci.yml` — CI jobs.
- `workflows/pr-check.yml` — PR policy.
- `workflows/deploy-iwinv.yml` — successful-main CI trigger to Jenkins.

## Invariants
- The trigger is disabled by default. Enable it only after the first manual Jenkins
  deployment passes public validation by setting repository variable
  `DEPLOY_ENABLED=true`; any other or unset value must not trigger deployment.
- Trigger only a successful `main` run for `SeniorAILab/eldercare-fall-ai`, sending
  its exact 40-lowercase-hex `SHA` and `REF=refs/heads/main`. No ordinary merge may
  bypass these checks.
- GitHub Actions sends the webhook using `Authorization: Bearer` and repository
  secret `WEBHOOK_TOKEN`. Jenkins stores the matching server credential as
  `eldercare-webhook-token`; never expose either value.
- GitHub Actions does not build, tag, push, SSH-deploy, retry, or roll back
  production images. Jenkins alone builds exact
  `eldercare-backend:<sha>`/`eldercare-front:<sha>` images and deploys them.
- Keep permissions minimal and fail before an external trigger when required input
  is absent.

## Anti-patterns
- No Naver Cloud, GHCR, manual-only deploy, `latest`, fallback ref/image/env, or
  automatic retry/rollback path.
- No deployment of ML services or ML images; ML remains edge-only.
- No broad `write-all` permissions or logging of tokens, credentials, or env data.