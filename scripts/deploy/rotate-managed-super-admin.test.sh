#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/rotate-managed-super-admin.sh
COMPOSE=$REPO_ROOT/compose.prod.yaml
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin"

cat > "$TMP/bin/ssh" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$*" > "$MOCK_SSH_LOG"
shift
if [ "${1:-}" = sudo ]; then shift; [ "${1:-}" = -n ] && shift; fi
exec "$@"
EOF

cat > "$TMP/bin/shred" <<'EOF'
#!/usr/bin/env sh
[ "$1" = -u ] || exit 2
mode=$(stat -c '%a' "$2" 2>/dev/null || stat -f '%Lp' "$2")
printf 'mode=%s path=%s\n' "$mode" "$2" > "$MOCK_SHRED_LOG"
rm -f "$2"
EOF

cat > "$TMP/bin/mv" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$*" > "$MOCK_MV_LOG"
exec /bin/mv "$@"
EOF
chmod +x "$TMP/bin/ssh" "$TMP/bin/shred" "$TMP/bin/mv"

cat > "$TMP/host.env" <<'EOF'
POSTGRES_PASSWORD=db-credential-sentinel
DATABASE_URL=postgresql://database-sentinel
JENKINS_API_TOKEN=jenkins-credential-sentinel
GOOGLE_APPLICATION_CREDENTIALS=/secure/google-sentinel.json
SSH_PRIVATE_KEY_PATH=/secure/ssh-sentinel
EDGE_FACILITY_TOKEN=edge-credential-sentinel
CAMERA_PASSWORD=camera-credential-sentinel
SUPER_ADMIN_EMAIL=old@example.test
SUPER_ADMIN_PASSWORD=old-sentinel
SUPER_ADMIN_NICKNAME=Legacy name
SUPER_ADMIN_FACILITY_ID=legacy-facility
EOF
chmod 600 "$TMP/host.env"

unrelated_fingerprint() {
  awk '!/^SUPER_ADMIN_/' "$1" | cksum
}

before=$(unrelated_fingerprint "$TMP/host.env")
SECRET=$(printf '%s%s' 'fixture-rotation-' 'secret-value')
printf '%s' "$SECRET" > "$TMP/secret"
chmod 600 "$TMP/secret"

output=$(
  PATH="$TMP/bin:$PATH" \
    MOCK_SSH_LOG="$TMP/ssh.log" \
    MOCK_SHRED_LOG="$TMP/shred.log" \
    MOCK_MV_LOG="$TMP/mv.log" \
    SUPER_ADMIN_PASSWORD_FD=9 \
    sh "$SCRIPT" \
      --target fixture-host \
      --env-file "$TMP/host.env" \
      --managed-key senior-ai-lab-primary \
      --email managed@example.test \
      --source-email old@example.test \
      9< "$TMP/secret" 2>&1
)

case "$output" in *MANAGED_SUPER_ADMIN_ENV_UPDATED*) ;; *) printf 'missing success marker\n%s\n' "$output" >&2; exit 1;; esac
case "$output" in *"$SECRET"*) printf 'secret leaked to output\n' >&2; exit 1;; esac
ssh_argv=$(cat "$TMP/ssh.log")
case "$ssh_argv" in *"$SECRET"*) printf 'secret leaked to ssh argv\n' >&2; exit 1;; esac
case "$ssh_argv" in *'fixture-host sudo -n sh -c'*) ;; *) printf 'remote mutation did not use noninteractive privilege boundary\n' >&2; exit 1;; esac
[ "$(unrelated_fingerprint "$TMP/host.env")" = "$before" ] || { printf 'unrelated environment changed\n' >&2; exit 1; }
[ "$(grep -c '^SUPER_ADMIN_' "$TMP/host.env")" -eq 4 ] || { printf 'managed input cardinality changed\n' >&2; exit 1; }
grep -Fx 'SUPER_ADMIN_MANAGED_KEY=senior-ai-lab-primary' "$TMP/host.env" >/dev/null
grep -Fx 'SUPER_ADMIN_EMAIL=managed@example.test' "$TMP/host.env" >/dev/null
grep -Fx 'SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL=old@example.test' "$TMP/host.env" >/dev/null
case "$(grep '^SUPER_ADMIN_PASSWORD=' "$TMP/host.env")" in *"$SECRET"*) ;; *) printf 'password was not installed\n' >&2; exit 1;; esac
mode=$(stat -c '%a' "$TMP/host.env" 2>/dev/null || stat -f '%Lp' "$TMP/host.env")
[ "$mode" = 600 ] || { printf 'host env mode changed: %s\n' "$mode" >&2; exit 1; }
grep -F 'mode=600 path=' "$TMP/shred.log" >/dev/null
grep -F "$TMP/.managed-super-admin-env." "$TMP/mv.log" >/dev/null
[ ! -e "$TMP/deploy.lock" ] || { printf 'remote lock leaked\n' >&2; exit 1; }
set -- "$TMP"/.managed-super-admin-*
[ "$1" = "$TMP/.managed-super-admin-*" ] || { printf 'remote temporary file leaked\n' >&2; exit 1; }
grep -F 'set +x' "$SCRIPT" >/dev/null
grep -F 'HISTFILE=/dev/null' "$SCRIPT" >/dev/null

set +e
missing_fd_output=$(SUPER_ADMIN_PASSWORD_FD=8 sh "$SCRIPT" --target fixture-host --env-file "$TMP/host.env" --managed-key senior-ai-lab-primary --email managed@example.test --source-email old@example.test 2>&1)
missing_fd_status=$?
set -e
[ "$missing_fd_status" -ne 0 ] || { printf 'missing descriptor unexpectedly passed\n' >&2; exit 1; }
case "$missing_fd_output" in *"$SECRET"*) printf 'secret leaked on descriptor failure\n' >&2; exit 1;; esac

env_before_failure=$(cksum "$TMP/host.env")
printf 'first-line\nsecond-line' > "$TMP/multiline-secret"
set +e
multiline_output=$(
  PATH="$TMP/bin:$PATH" MOCK_SSH_LOG="$TMP/ssh.log" MOCK_SHRED_LOG="$TMP/shred.log" MOCK_MV_LOG="$TMP/mv.log" \
    SUPER_ADMIN_PASSWORD_FD=9 sh "$SCRIPT" --target fixture-host --env-file "$TMP/host.env" \
      --managed-key senior-ai-lab-primary --email managed@example.test --source-email old@example.test \
      9< "$TMP/multiline-secret" 2>&1
)
multiline_status=$?
set -e
[ "$multiline_status" -ne 0 ] || { printf 'multiline descriptor unexpectedly passed\n' >&2; exit 1; }
[ "$(cksum "$TMP/host.env")" = "$env_before_failure" ] || { printf 'failed rotation changed host environment\n' >&2; exit 1; }
case "$multiline_output" in *first-line*|*second-line*) printf 'invalid secret leaked on failure\n' >&2; exit 1;; esac
[ ! -e "$TMP/deploy.lock" ] || { printf 'failure lock leaked\n' >&2; exit 1; }

[ "$(grep -c 'SUPER_ADMIN_' "$COMPOSE")" -eq 4 ] || { printf 'production compose must expose exactly four managed inputs\n' >&2; exit 1; }
grep -F 'SUPER_ADMIN_MANAGED_KEY:' "$COMPOSE" >/dev/null
grep -F 'SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL:' "$COMPOSE" >/dev/null
if grep -E 'SUPER_ADMIN_(NICKNAME|FACILITY_ID)' "$COMPOSE" >/dev/null; then
  printf 'production compose still exposes unmanaged identity inputs\n' >&2
  exit 1
fi

printf '%s\n' 'MANAGED_SUPER_ADMIN_ROTATION_FIXTURE_OK'
