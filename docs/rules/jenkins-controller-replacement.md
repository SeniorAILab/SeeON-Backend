# Jenkins controller immutable-image replacement

Use this only after the replacement PR is merged and independently verified.
It replaces the controller container, not Jenkins state. Do not trigger a build,
release, or deployment during the operation.

## Preserved contract

The canonical files are `infra/jenkins/{Dockerfile,plugins.txt,compose.yaml}`.
The Compose service keeps all existing state-bearing mounts and runtime identity:

- `/opt/jenkins/home` -> `/var/jenkins_home` (jobs, build #37 history, credentials)
- existing CasC, Job DSL, admin/webhook/GitHub/SMTP secret files, and pinned
  `known_hosts`, all mounted from `/opt/jenkins`
- `/opt/eldercare-fall-ai`, `/var/run/docker.sock`, Docker CLI, buildx, and
  Compose mounts
- UID/GID `1001:1001`, Docker group `986`, loopback port 8080, memory limit,
  timezone, and `unless-stopped` restart policy

Never copy, migrate, chown, delete, or replace `/opt/jenkins/home` or
`/opt/jenkins/secrets` during this procedure.

## Pre-check and build

Run from an exact merged `SeniorAILab/SeeON-Backend` checkout. Keep the shell
open: its variables are the rollback receipt.

```sh
set -eu
cd /opt/eldercare-fall-ai/repo
test -z "$(git status --porcelain)"
sh scripts/deploy/jenkins-controller-image.test.sh

controller=eldercare-jenkins
service_file=/opt/jenkins/compose.yaml
prior_image_id=$(sudo docker inspect "$controller" --format '{{.Image}}')
prior_next_build=$(sudo docker exec "$controller" cat /var/jenkins_home/jobs/eldercare-fall-ai-cd/nextBuildNumber)
sudo docker exec "$controller" test -d /var/jenkins_home/jobs/eldercare-fall-ai-cd/builds/37
sudo docker exec "$controller" test -s /var/jenkins_home/credentials.xml
for path in \
  /opt/jenkins/home \
  /opt/jenkins/casc.yaml \
  /opt/jenkins/jobs.groovy \
  /opt/jenkins/secrets/webhook_token \
  /opt/jenkins/secrets/github_deploy_key \
  /opt/jenkins/secrets/known_hosts \
  /opt/eldercare-fall-ai \
  /var/run/docker.sock; do
  sudo test -e "$path"
done
sudo docker inspect "$controller" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
sudo docker exec "$controller" docker --version
sudo docker exec "$controller" docker buildx version
sudo docker exec "$controller" docker compose version

stamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_tag="eldercare-jenkins:rollback-${stamp}"
definition_backup="/opt/jenkins/controller-definition-${stamp}"
sudo docker image tag "$prior_image_id" "$rollback_tag"
sudo install -d -m 0700 "$definition_backup"
sudo cp /opt/jenkins/Dockerfile /opt/jenkins/plugins.txt /opt/jenkins/compose.yaml "$definition_backup/"
sudo install -m 0644 infra/jenkins/Dockerfile infra/jenkins/plugins.txt infra/jenkins/compose.yaml /opt/jenkins/

sudo docker compose -p jenkins -f "$service_file" build --pull jenkins
candidate_image_id=$(sudo docker image inspect eldercare-jenkins:lts-jdk21-locked --format '{{.Id}}')
test "$candidate_image_id" != "$prior_image_id"
sudo docker run --rm --platform linux/amd64 --network none --entrypoint sh \
  eldercare-jenkins:lts-jdk21-locked -c \
  'test "$(jq --version)" = jq-1.7 && test "$(id -u jenkins)" = 1001 && jenkins-plugin-cli --version'
```

## Replace and verify

The only state-changing controller command is the forced service recreation.
The bind-mounted home and secrets remain in place.

```sh
sudo docker compose -p jenkins -f "$service_file" up -d --no-deps --no-build --force-recreate jenkins

new_image_id=$(sudo docker inspect "$controller" --format '{{.Image}}')
test "$new_image_id" = "$candidate_image_id"
test "$(sudo docker inspect "$controller" --format '{{.HostConfig.RestartPolicy.Name}}')" = unless-stopped
test "$(sudo docker inspect "$controller" --format '{{.Config.User}}')" = 1001:1001
sudo docker exec "$controller" test -x /usr/bin/jq
sudo docker exec "$controller" jq --version
sudo docker exec "$controller" docker --version
sudo docker exec "$controller" docker buildx version
sudo docker exec "$controller" docker compose version
sudo docker exec "$controller" test -d /var/jenkins_home/jobs/eldercare-fall-ai-cd/builds/37
test "$(sudo docker exec "$controller" cat /var/jenkins_home/jobs/eldercare-fall-ai-cd/nextBuildNumber)" = "$prior_next_build"
sudo docker exec "$controller" test -s /var/jenkins_home/credentials.xml
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-all-errors \
  http://127.0.0.1:8080/login >/dev/null
sudo docker inspect "$controller" --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

Confirm the mount list still includes Jenkins home, CasC, Job DSL, every secret,
`known_hosts`, deploy root, Docker socket, Docker CLI, buildx, and Compose. Do
not start build #38 as part of this replacement.

## Immediate rollback

Run this immediately if any replacement or post-check fails. It restores the
three controller definitions and recreates the controller from the exact prior
image ID while retaining the same state mounts.

```sh
sudo cp "$definition_backup/Dockerfile" "$definition_backup/plugins.txt" \
  "$definition_backup/compose.yaml" /opt/jenkins/
sudo docker image tag "$rollback_tag" eldercare-jenkins:lts-jdk21-locked
sudo docker compose -p jenkins -f /opt/jenkins/compose.yaml up -d \
  --no-deps --no-build --force-recreate jenkins
test "$(sudo docker inspect eldercare-jenkins --format '{{.Image}}')" = "$prior_image_id"
test "$(sudo docker exec eldercare-jenkins cat /var/jenkins_home/jobs/eldercare-fall-ai-cd/nextBuildNumber)" = "$prior_next_build"
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-all-errors \
  http://127.0.0.1:8080/login >/dev/null
```

Keep the rollback tag and definition backup until a later, separately approved
cleanup window.
