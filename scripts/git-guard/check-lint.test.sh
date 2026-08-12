#!/usr/bin/env sh
set -eu

SCRIPT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/check-lint.sh
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/check-lint-test.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/repo/node_modules"

cat >"$TMP_ROOT/bin/git" <<'EOF'
#!/usr/bin/env sh
case "$*" in
  'rev-parse --show-toplevel') printf '%s\n' "$TEST_REPO" ;;
  'rev-parse --verify --quiet origin/main') exit 0 ;;
  'diff --name-only origin/main...HEAD') printf '%s\n' 'backend/src/example.ts' 'pnpm-workspace.yaml' ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 1 ;;
esac
EOF
cat >"$TMP_ROOT/bin/pnpm" <<'EOF'
#!/usr/bin/env sh
printf '%s\n' "$*" >>"$COMMAND_LOG"
EOF
cat >"$TMP_ROOT/bin/docker" <<'EOF'
#!/usr/bin/env sh
exit 0
EOF
chmod +x "$TMP_ROOT/bin/git" "$TMP_ROOT/bin/pnpm" "$TMP_ROOT/bin/docker"

COMMAND_LOG=$TMP_ROOT/commands.log
TEST_REPO=$TMP_ROOT/repo
: >"$COMMAND_LOG"
export COMMAND_LOG TEST_REPO
PATH="$TMP_ROOT/bin:$PATH" sh "$SCRIPT"

if grep -F -- '--filter front' "$COMMAND_LOG" >/dev/null; then
  printf '%s\n' 'backend-only lint gate invoked the removed front workspace' >&2
  exit 1
fi
for command in \
  '--filter backend run dto:check' \
  '--filter backend exec tsc --noEmit' \
  '--filter backend run lint'
do
  grep -Fx -- "$command" "$COMMAND_LOG" >/dev/null || {
    printf 'backend lint gate did not invoke: %s\n' "$command" >&2
    exit 1
  }
done

printf '%s\n' 'CHECK_LINT_BACKEND_ONLY_OK'
