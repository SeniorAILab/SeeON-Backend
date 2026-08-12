#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
IMAGE="seeon-jenkins-controller-contract:$$"
SHA=0123456789abcdef0123456789abcdef01234567
cleanup() {
  docker image rm --force "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

fail() { printf '%s\n' "$1" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'Docker is required for the Jenkins controller image contract'
docker buildx version >/dev/null 2>&1 || fail 'Docker buildx is required by the Jenkins controller service'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose is required by the Jenkins controller service'

docker build --pull --platform linux/amd64 \
  --tag "$IMAGE" "$REPO_ROOT/infra/jenkins"

[ "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" = amd64 ] || fail 'Jenkins controller image must target linux/amd64'
[ "$(docker image inspect "$IMAGE" --format '{{.Os}}')" = linux ] || fail 'Jenkins controller image must target linux/amd64'
[ "$(docker image inspect "$IMAGE" --format '{{.Config.User}}')" = jenkins ] || fail 'Jenkins controller image must retain the Jenkins user'
[ "$(docker image inspect "$IMAGE" --format '{{json .Config.Entrypoint}}')" = '["/usr/bin/tini","--","/usr/local/bin/jenkins.sh"]' ] || fail 'Jenkins controller entrypoint changed'
docker image inspect "$IMAGE" --format '{{json .Config.Volumes}}' | grep -F '"/var/jenkins_home"' >/dev/null || fail 'Jenkins home volume contract changed'

docker run --rm --platform linux/amd64 --network none --entrypoint sh \
  --volume "$REPO_ROOT:/workspace:ro" "$IMAGE" -c '
    set -eu
    [ "$(id -u)" = 1001 ]
    [ "$(id -g)" = 1001 ]
    [ "$JENKINS_VERSION" = 2.568.1 ]
    grep -Fx "VERSION_CODENAME=trixie" /etc/os-release >/dev/null
    command -v jq >/dev/null 2>&1
    [ "$(jq --version)" = jq-1.7 ]
    [ "$(dpkg-query -W -f="\${Version}" jq)" = 1.7.1-6+deb13u2 ]
    [ "$(dpkg-query -W -f="\${Version}" libjq1)" = 1.7.1-6+deb13u2 ]
    [ ! -e /var/lib/apt/lists/lock ]
    cmp /workspace/infra/jenkins/plugins.txt /usr/share/jenkins/ref/plugins.txt
    while IFS=: read -r plugin expected; do
      [ -n "$plugin" ] || continue
      actual=$(unzip -p "/usr/share/jenkins/ref/plugins/$plugin.jpi" META-INF/MANIFEST.MF |
        tr -d "\r" | sed -n "s/^Plugin-Version: //p" | head -1)
      [ "$actual" = "$expected" ] || {
        printf "plugin version mismatch: %s expected=%s actual=%s\n" "$plugin" "$expected" "$actual" >&2
        exit 1
      }
    done < /workspace/infra/jenkins/plugins.txt
    jq -e --arg sha '"$SHA"' '\''
      (.check_runs | type == "array") and
      ([.check_runs[] |
        select(
          .name == "CI gate" and
          .head_sha == $sha and
          .status == "completed" and
          .conclusion == "success"
        )] | length == 1)
    '\'' <<JSON >/dev/null
{"check_runs":[{"name":"CI gate","head_sha":"'"$SHA"'","status":"completed","conclusion":"success"}]}
JSON
    sh /workspace/scripts/release/verify-github-ci-gate.test.sh
  '

compose_json=$(docker compose --project-directory "$REPO_ROOT/infra/jenkins" \
  --file "$REPO_ROOT/infra/jenkins/compose.yaml" config --format json)
printf '%s\n' "$compose_json" | jq -e '
  .services.jenkins.image == "eldercare-jenkins:lts-jdk21-locked" and
  .services.jenkins.user == "1001:1001" and
  .services.jenkins.restart == "unless-stopped" and
  (.services.jenkins.group_add | index("986") != null) and
  ([.services.jenkins.volumes[] | select(.source == "/opt/jenkins/home" and .target == "/var/jenkins_home" and .type == "bind" and ((.read_only // false) == false))] | length == 1) and
  ([.services.jenkins.volumes[] | select(.source == "/opt/jenkins/secrets/known_hosts" and .target == "/etc/ssh/ssh_known_hosts" and .read_only == true)] | length == 1) and
  ([.services.jenkins.volumes[] | select(.source == "/var/run/docker.sock" and .target == "/var/run/docker.sock")] | length == 1) and
  ([.services.jenkins.volumes[] | select(.source == "/usr/bin/docker" and .target == "/usr/bin/docker" and .read_only == true)] | length == 1) and
  ([.services.jenkins.volumes[] | select(.target == "/usr/local/lib/docker/cli-plugins/docker-buildx" and .read_only == true)] | length == 1) and
  ([.services.jenkins.volumes[] | select(.target == "/usr/local/lib/docker/cli-plugins/docker-compose" and .read_only == true)] | length == 1) and
  ([.services.jenkins.volumes[] | select(.source == "/opt/eldercare-fall-ai" and .target == "/opt/eldercare-fall-ai" and ((.read_only // false) == false))] | length == 1)
' >/dev/null || fail 'Jenkins controller Compose ownership contract changed'

printf '%s\n' 'Jenkins controller linux/amd64 image and service contracts passed'
