#!/usr/bin/env sh
set -eu

[ "$#" -eq 1 ] || exit 2
ENV_FILE=$1
[ -f "$ENV_FILE" ] || exit 2

# Exit 3 only for a Compose-supported declaration. Other nonzero statuses are
# producer/read failures and must remain distinguishable to the caller.
awk '
  {
    line = $0
    sub(/\r$/, "", line)
    if (match(line, /^[[:blank:]]*(export[[:blank:]]+)?EVENT_CLIPS_ENABLED[[:blank:]]*/)) {
      remainder = substr(line, RLENGTH + 1)
      if (remainder == "" || substr(remainder, 1, 1) == "=" || substr(remainder, 1, 1) == "#") {
        found = 1
      }
    }
  }
  END {
    if (found) exit 3
  }
' "$ENV_FILE"
