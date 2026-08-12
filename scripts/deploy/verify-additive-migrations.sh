#!/usr/bin/env sh
set -eu
set +x

APP_DIR=${APP_DIR:-/opt/eldercare-fall-ai/repo}

fail() { printf '%s\n' "$1" >&2; exit 1; }
valid_sha() { [ "${#1}" -eq 40 ] && printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }

[ "$#" -eq 2 ] || fail 'Usage: verify-additive-migrations.sh <current-sha> <candidate-sha>'
CURRENT_SHA=$1
CANDIDATE_SHA=$2
if ! valid_sha "$CURRENT_SHA" || ! valid_sha "$CANDIDATE_SHA"; then
  fail 'migration classifier SHAs must be exactly 40 lowercase hexadecimal characters'
fi
for tool in awk cat git grep mktemp rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "required migration classification tool is missing: $tool"
done
git -C "$APP_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail 'application Git repository is required for migration classification'
git -C "$APP_DIR" cat-file -e "$CURRENT_SHA^{commit}" 2>/dev/null || fail 'current release commit is unavailable for migration classification'
git -C "$APP_DIR" cat-file -e "$CANDIDATE_SHA^{commit}" 2>/dev/null || fail 'candidate release commit is unavailable for migration classification'
git -C "$APP_DIR" merge-base --is-ancestor "$CURRENT_SHA" "$CANDIDATE_SHA" || fail 'candidate release must descend from the current release'

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/seeon-migration-classifier.XXXXXX") || fail 'unable to create migration classification workspace'
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM
changes=$TMP_DIR/changes
if ! git -C "$APP_DIR" diff --name-status "$CURRENT_SHA" "$CANDIDATE_SHA" -- 'backend/prisma/migrations/*/migration.sql' > "$changes"; then
  fail 'unable to enumerate candidate migrations'
fi

while IFS="$(printf '\t')" read -r status migration_file extra; do
  [ -n "$status" ] || continue
  [ "$status" = A ] && [ -z "${extra:-}" ] || fail 'candidate release must not modify, delete, or rename existing migrations'
  printf '%s\n' "$migration_file" | grep -Eq '^backend/prisma/migrations/[0-9]{14}_[a-z0-9_]+/migration[.]sql$' || fail 'candidate migration path is invalid'

  sql=$TMP_DIR/sql
  normalized=$TMP_DIR/normalized
  git -C "$APP_DIR" show "$CANDIDATE_SHA:$migration_file" > "$sql" || fail "unable to inspect candidate migration: $migration_file"

  # Lex PostgreSQL comments and quoted values before classification. Block
  # comments are nested; quoted and dollar-quoted bodies are removed. This
  # prevents comment gaps from hiding executable tokens while ensuring prose
  # or inert string values containing words such as DROP do not classify as SQL.
  if ! awk '
    BEGIN { state="normal"; depth=0; tag="" }
    {
      text=$0 "\n"
      for (i=1; i<=length(text); i++) {
        c=substr(text,i,1); pair=substr(text,i,2); rest=substr(text,i)
        if (state == "line") {
          if (c == "\n") { state="normal"; printf " " }
        } else if (state == "block") {
          if (pair == "/*") { depth++; i++ }
          else if (pair == "*/") { depth--; i++; if (depth == 0) { state="normal"; printf " " } }
        } else if (state == "single") {
          if (pair == "\047\047") { i++ }
          else if (c == "\047") { state="normal"; printf " Q " }
        } else if (state == "double") {
          if (pair == "\"\"") { i++ }
          else if (c == "\"") { state="normal"; printf " Q " }
        } else if (state == "dollar") {
          if (substr(rest,1,length(tag)) == tag) { i += length(tag)-1; state="normal"; printf " Q " }
        } else if (pair == "--") {
          state="line"; i++
        } else if (pair == "/*") {
          state="block"; depth=1; i++
        } else if (c == "\047") {
          state="single"; printf " "
        } else if (c == "\"") {
          state="double"; printf " "
        } else if (c == "$" && match(rest, /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)) {
          tag=substr(rest,RSTART,RLENGTH); state="dollar"; i += RLENGTH-1; printf " "
        } else if (c ~ /[[:space:]]/) {
          printf " "
        } else {
          printf "%s", toupper(c)
        }
      }
    }
    END {
      if (state != "normal" && state != "line") exit 42
      printf "\n"
    }
  ' "$sql" > "$normalized"; then
    fail "candidate migration is not additive/non-destructive: $migration_file (unterminated SQL comment or quote)"
  fi

  executable=$(cat "$normalized")
  if printf '%s\n' "$executable" | grep -Eq '(^|[^A-Z_])(DROP|TRUNCATE|REVOKE|DO|EXECUTE|CALL|REINDEX|CLUSTER)([^A-Z_]|$)|(^|[^A-Z_])DELETE[[:space:]]+FROM([^A-Z_]|$)|(^|[^A-Z_])ON[[:space:]]+CONFLICT([^A-Z_]|$)|(^|[^A-Z_])CREATE[[:space:]]+OR[[:space:]]+REPLACE([^A-Z_]|$)|(^|[^A-Z_])CREATE[[:space:]]+(FUNCTION|PROCEDURE|RULE|TRIGGER)([^A-Z_]|$)|(^|[^A-Z_])ALTER[[:space:]]+TABLE[^;]*(RENAME|DROP|ALTER|SET|RESET|ENABLE|DISABLE|VALIDATE|ATTACH|DETACH|INHERIT|OWNER)([^A-Z_]|$)|(^|[^A-Z_])ALTER[[:space:]]+TYPE[^;]*RENAME([^A-Z_]|$)|(^|[^A-Z_])VACUUM[[:space:]]+FULL([^A-Z_]|$)'; then
    fail "candidate migration is not additive/non-destructive: $migration_file"
  fi

  # Fail closed on unknown statement families. The accepted forms only add a
  # relation/type/index/schema object, add a table column/constraint, append an
  # enum value or row, grant access, or attach inert documentation. Expanding
  # this list requires its own reviewed contract tests.
  if ! awk '
    BEGIN { RS=";" }
    {
      statement=$0
      gsub(/[[:space:]]+/, " ", statement)
      sub(/^ /, "", statement); sub(/ $/, "", statement)
      if (statement == "") next
      if (statement ~ /^CREATE (TABLE|TYPE|DOMAIN|SCHEMA|SEQUENCE|EXTENSION|VIEW) /) next
      if (statement ~ /^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?/) next
      if (statement ~ /^ALTER TABLE .* ADD (COLUMN |CONSTRAINT )/) next
      if (statement ~ /^ALTER TYPE .* ADD VALUE /) next
      if (statement ~ /^INSERT INTO /) next
      if (statement ~ /^GRANT /) next
      if (statement ~ /^COMMENT ON /) next
      exit 1
    }
  ' "$normalized"; then
    fail "candidate migration is not additive/non-destructive: $migration_file"
  fi
done < "$changes"

printf '%s\n' 'candidate migrations are additive/non-destructive'
