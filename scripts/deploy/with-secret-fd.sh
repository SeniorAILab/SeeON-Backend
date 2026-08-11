#!/usr/bin/env sh
set -eu
set +x
HISTFILE=/dev/null
export HISTFILE

fail() { printf '%s\n' "$1" >&2; exit 1; }

if [ "${1:-}" = --fixture ]; then
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/with-secret-fd.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  secret=$(printf '%s%s' fixture-secret- descriptor-only)
  printf '%s' "$secret" > "$tmp/source"
  chmod 600 "$tmp/source"
  output=$(SECRET_SOURCE_FD=8 WITH_SECRET_FD_FIXTURE_CHILD=1 sh "$0" sh -c '
    [ -r "/dev/fd/$EDGE_PROVISIONING_SECRET_FD" ]
    value=$(cat "/dev/fd/$EDGE_PROVISIONING_SECRET_FD")
    [ "$value" = fixture-secret-descriptor-only ]
    case "$*" in *fixture-secret-descriptor-only*) exit 9 ;; esac
    printf child-ok
  ' child 8< "$tmp/source" 2>&1)
  [ "$output" = child-ok ] || fail 'secret descriptor child failed'
  case "$output" in *"$secret"*) fail 'secret leaked to output' ;; esac
  set +e
  missing=$(SECRET_SOURCE_FD=7 sh "$0" true 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'unreadable descriptor fixture passed'
  case "$missing" in *"$secret"*) fail 'secret leaked on descriptor failure' ;; esac
  leaked=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'edge-provisioning-secret.*' -type f -print)
  [ -z "$leaked" ] || fail 'secret temporary file leaked'
  printf '%s\n' 'WITH_SECRET_FD_FIXTURE_OK'
  exit 0
fi

[ "$#" -gt 0 ] || fail 'command is required'
source_fd=${SECRET_SOURCE_FD:-0}
case "$source_fd" in ''|*[!0-9]*) fail 'SECRET_SOURCE_FD must be a descriptor number' ;; esac
[ -r "/dev/fd/$source_fd" ] || fail 'secret source descriptor is not readable'

umask 077
secret_file=$(mktemp "${TMPDIR:-/tmp}/edge-provisioning-secret.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -e "$secret_file" ]; then
    if command -v shred >/dev/null 2>&1; then shred -u "$secret_file" || rm -f "$secret_file"
    else rm -f "$secret_file"; fi
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
cat "/dev/fd/$source_fd" > "$secret_file"
chmod 600 "$secret_file"
[ -s "$secret_file" ] || fail 'secret source descriptor is empty'
[ "$(wc -l < "$secret_file" | tr -d ' ')" -eq 0 ] || fail 'secret must not contain a newline'
exec 9< "$secret_file"
rm -f "$secret_file"
EDGE_PROVISIONING_SECRET_FD=9
export EDGE_PROVISIONING_SECRET_FD
exec "$@"
