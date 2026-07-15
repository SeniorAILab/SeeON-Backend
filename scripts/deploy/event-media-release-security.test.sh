#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/verify-event-media-release.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/bin" "$TMP/headers"
EXPECTED_MEDIA_OUTCOMES='200 206 401 403 404 416'

cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env sh
[ -n "${MOCK_CURL_LOG:-}" ] && printf '%s\n' "$*" >> "$MOCK_CURL_LOG"
case "${MOCK_TLS_MODE:-ok}" in
  fail) exit 35 ;;
  no-hsts) printf '%s\r\n' 'HTTP/2 200' 'Content-Length: 0' '' ;;
  weak-hsts) printf '%s\r\n' 'HTTP/2 200' 'Strict-Transport-Security: max-age=60' '' ;;
  *) printf '%s\r\n' 'HTTP/2 200' 'Strict-Transport-Security: max-age=31536000; includeSubDomains' '' ;;
esac
EOF
chmod +x "$TMP/bin/curl"

cat > "$TMP/host.env" <<'EOF'
FRONT_ORIGIN=https://care.example.invalid
AUTH_COOKIE_SECURE=true
EVENT_CLIPS_ENABLED=true
EOF
chmod 600 "$TMP/host.env"

for outcome in $EXPECTED_MEDIA_OUTCOMES; do
  cat > "$TMP/headers/$outcome.headers" <<EOF
HTTP/1.1 $outcome Synthetic
Cache-Control: private, no-store, no-transform
Content-Type: application/json
EOF
done

cat > "$TMP/access.log" <<'EOF'
route=event-media outcome=200
route=event-media outcome=206
route=event-media outcome=401
route=event-media outcome=403
route=event-media outcome=404
route=event-media outcome=416
EOF
chmod 600 "$TMP/access.log"

run_gate() {
  PATH="$TMP/bin:$PATH" \
  PUBLIC_ORIGIN=https://care.example.invalid \
  PRODUCTION_ENV_FILE="$TMP/host.env" \
  MEDIA_HEADER_PROOF_DIR="$TMP/headers" \
  OUTER_PROXY_ACCESS_LOG="$TMP/access.log" \
  MOCK_CURL_LOG="$TMP/curl.log" \
    sh "$SCRIPT" 2>&1
}

assert_failure() {
  [ "$1" -ne 0 ] || { printf '%s\n' 'security gate unexpectedly passed' >&2; exit 1; }
}
assert_contains() {
  case "$1" in *"$2"*) ;; *) printf 'missing expected output: %s\n' "$2" >&2; exit 1;; esac
}
assert_not_contains() {
  case "$1" in *"$2"*) printf 'unexpected output: %s\n' "$2" >&2; exit 1;; *) ;; esac
}

output=$(run_gate)
assert_contains "$output" 'event media release security verified'
assert_not_contains "$output" 'care.example.invalid'
curl_log=$(cat "$TMP/curl.log")
script_outcomes=$(sed -n "s/^MEDIA_OUTCOMES='\([^']*\)'$/\1/p" "$SCRIPT")
[ "$script_outcomes" = "$EXPECTED_MEDIA_OUTCOMES" ] || {
  printf 'media outcome contract drifted: %s\n' "$script_outcomes" >&2
  exit 1
}
[ ! -e "$TMP/headers/400.headers" ] || { printf '%s\n' 'malformed Range must not require a 400 proof' >&2; exit 1; }
assert_contains "$curl_log" '--proto =https'
assert_contains "$curl_log" '--tlsv1.2'

# Missing proof inputs fail before a network probe, so an incomplete release
# cannot be mistaken for a secure one.
: > "$TMP/curl.log"
set +e
output=$(PATH="$TMP/bin:$PATH" PUBLIC_ORIGIN=https://care.example.invalid \
  PRODUCTION_ENV_FILE="$TMP/host.env" MEDIA_HEADER_PROOF_DIR="$TMP/headers" \
  sh "$SCRIPT" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy access log proof is required'
[ ! -s "$TMP/curl.log" ] || { printf '%s\n' 'missing inputs reached curl' >&2; exit 1; }

set +e
output=$(PATH="$TMP/bin:$PATH" PUBLIC_ORIGIN=http://care.example.invalid \
  PRODUCTION_ENV_FILE="$TMP/host.env" MEDIA_HEADER_PROOF_DIR="$TMP/headers" \
  OUTER_PROXY_ACCESS_LOG="$TMP/access.log" sh "$SCRIPT" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'public origin must be a bare HTTPS origin'

MOCK_TLS_MODE=no-hsts
export MOCK_TLS_MODE
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy HSTS proof failed'
MOCK_TLS_MODE=weak-hsts
export MOCK_TLS_MODE
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy HSTS proof failed'
unset MOCK_TLS_MODE

cp "$TMP/host.env" "$TMP/host.env.good"
sed 's/AUTH_COOKIE_SECURE=true/AUTH_COOKIE_SECURE=false/' "$TMP/host.env.good" > "$TMP/host.env"
chmod 600 "$TMP/host.env"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'production cookies must be explicitly Secure'
mv "$TMP/host.env.good" "$TMP/host.env"

cp "$TMP/headers/416.headers" "$TMP/416.good"
sed 's/private, no-store, no-transform/private, no-cache/' "$TMP/416.good" > "$TMP/headers/416.headers"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'media outcome cache policy proof failed'
mv "$TMP/416.good" "$TMP/headers/416.headers"

rm "$TMP/headers/404.headers"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'media outcome header proof is required'
cat > "$TMP/headers/404.headers" <<'EOF'
HTTP/1.1 404 Synthetic
Cache-Control: private, no-store, no-transform
EOF

cp "$TMP/access.log" "$TMP/access.good"
printf '%s\n' 'route=/api/v1/alerts/resident-event/media/content status=206' >> "$TMP/access.log"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy access log redaction proof failed'
assert_not_contains "$output" 'resident-event'
mv "$TMP/access.good" "$TMP/access.log"

cp "$TMP/access.log" "$TMP/access.good"
printf '%s\n' 'authorization=Bearer synthetic-secret' >> "$TMP/access.log"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy access log redaction proof failed'
assert_not_contains "$output" 'synthetic-secret'
mv "$TMP/access.good" "$TMP/access.log"

cp "$TMP/access.log" "$TMP/access.good"
grep -v 'outcome=403' "$TMP/access.good" > "$TMP/access.log"
set +e
output=$(run_gate); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy media outcome log proof is incomplete'
mv "$TMP/access.good" "$TMP/access.log"

ln -s "$TMP/access.log" "$TMP/access-link.log"
set +e
output=$(PATH="$TMP/bin:$PATH" PUBLIC_ORIGIN=https://care.example.invalid \
  PRODUCTION_ENV_FILE="$TMP/host.env" MEDIA_HEADER_PROOF_DIR="$TMP/headers" \
  OUTER_PROXY_ACCESS_LOG="$TMP/access-link.log" sh "$SCRIPT" 2>&1); status=$?
set -e
assert_failure "$status"
assert_contains "$output" 'outer proxy access log proof must be a regular non-symbolic file'

printf '%s\n' 'event media release security tests passed'
