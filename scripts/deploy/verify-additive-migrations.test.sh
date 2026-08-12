#!/usr/bin/env sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
SCRIPT=$REPO_ROOT/scripts/deploy/verify-additive-migrations.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
REPO=$TMP/repo
mkdir -p "$REPO/backend/prisma/migrations/20260811000000_existing"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name test
printf '%s\n' 'CREATE TABLE existing (id text PRIMARY KEY);' > "$REPO/backend/prisma/migrations/20260811000000_existing/migration.sql"
git -C "$REPO" add .
git -C "$REPO" commit -qm base
BASE=$(git -C "$REPO" rev-parse HEAD)

mkdir -p "$REPO/backend/prisma/migrations/20260812000000_additive"
cat > "$REPO/backend/prisma/migrations/20260812000000_additive/migration.sql" <<'SQL'
-- Harmless documentation may name DROP TABLE without becoming executable SQL.
/* A quoted migration example: DELETE FROM historical_rows; */
ALTER TABLE existing ADD COLUMN note text;
CREATE INDEX existing_note_idx ON existing (note);
INSERT INTO existing (id, note) VALUES ('literal DROP TABLE text', 'DELETE FROM is inert here');
SQL
git -C "$REPO" add .
git -C "$REPO" commit -qm additive
ADDITIVE=$(git -C "$REPO" rev-parse HEAD)

output=$(APP_DIR="$REPO" sh "$SCRIPT" "$BASE" "$ADDITIVE")
case "$output" in *'candidate migrations are additive/non-destructive'*) ;; *) printf '%s\n' "$output" >&2; exit 1;; esac

assert_destructive() {
  name=$1
  sql=$2
  git -C "$REPO" reset -q --hard "$ADDITIVE"
  rm -rf "$REPO/backend/prisma/migrations/20260813000000_destructive"
  mkdir -p "$REPO/backend/prisma/migrations/20260813000000_destructive"
  printf '%s\n' "$sql" > "$REPO/backend/prisma/migrations/20260813000000_destructive/migration.sql"
  git -C "$REPO" add .
  git -C "$REPO" commit -qm "destructive $name"
  candidate=$(git -C "$REPO" rev-parse HEAD)
  set +e
  output=$(APP_DIR="$REPO" sh "$SCRIPT" "$ADDITIVE" "$candidate" 2>&1); status=$?
  set -e
  [ "$status" -ne 0 ] || { printf 'destructive migration passed (%s): %s\n' "$name" "$sql" >&2; exit 1; }
  case "$output" in *'candidate migration is not additive/non-destructive'*) ;; *) printf '%s\n' "$output" >&2; exit 1;; esac
}

assert_destructive drop-table 'DROP TABLE existing;'
assert_destructive block-comment-gap 'DROP /* comment cannot hide the statement */ TABLE existing;'
assert_destructive drop-column 'ALTER TABLE existing DROP COLUMN note;'
assert_destructive rename-column 'ALTER TABLE existing RENAME COLUMN note TO old_note;'
assert_destructive alter-column 'ALTER TABLE existing ALTER COLUMN note TYPE integer USING 0;'
assert_destructive truncate 'TRUNCATE TABLE existing;'
assert_destructive delete 'DELETE FROM existing;'
assert_destructive revoke 'REVOKE SELECT ON existing FROM fall_app;'
assert_destructive update-existing "UPDATE existing SET note = 'rewritten';"
assert_destructive insert-upsert "INSERT INTO existing (id) VALUES ('x') ON CONFLICT (id) DO UPDATE SET note = 'rewritten';"
assert_destructive disable-rls 'ALTER TABLE existing DISABLE ROW LEVEL SECURITY;'
assert_destructive attach-partition 'ALTER TABLE existing ATTACH PARTITION existing_old FOR VALUES IN ('\''old'\'');'
assert_destructive create-trigger 'CREATE TRIGGER destructive BEFORE UPDATE ON existing EXECUTE FUNCTION destroy_rows();'
assert_destructive select-side-effect 'SELECT destructive_function();'
assert_destructive dynamic-do "DO \$body\$ BEGIN EXECUTE 'DROP TABLE existing'; END \$body\$;"
assert_destructive dynamic-function "CREATE FUNCTION destroy_rows() RETURNS void LANGUAGE plpgsql AS \$fn\$ BEGIN EXECUTE 'DELETE FROM existing'; END \$fn\$;"
assert_destructive unterminated-comment 'ALTER TABLE existing ADD COLUMN safe text; /*'
assert_destructive unterminated-string "INSERT INTO existing (id) VALUES ('unsafe);"

# A candidate outside the current release ancestry must fail closed.
git -C "$REPO" checkout -q --orphan unrelated
git -C "$REPO" rm -q -rf .
mkdir -p "$REPO/backend/prisma/migrations/20260814000000_unrelated"
printf '%s\n' 'CREATE TABLE unrelated (id text);' > "$REPO/backend/prisma/migrations/20260814000000_unrelated/migration.sql"
git -C "$REPO" add .
git -C "$REPO" commit -qm unrelated
UNRELATED=$(git -C "$REPO" rev-parse HEAD)
set +e
output=$(APP_DIR="$REPO" sh "$SCRIPT" "$ADDITIVE" "$UNRELATED" 2>&1); status=$?
set -e
[ "$status" -ne 0 ] || { printf '%s\n' 'unrelated candidate unexpectedly passed' >&2; exit 1; }
case "$output" in *'candidate release must descend from the current release'*) ;; *) printf '%s\n' "$output" >&2; exit 1;; esac

printf '%s\n' 'additive migration classifier tests passed'
