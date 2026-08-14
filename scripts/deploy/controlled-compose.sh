#!/usr/bin/env sh

# Compose gives inherited process variables precedence over ordered --env-file
# inputs. Remove every production-file value used as an exact deploy-smoke
# authority, plus the two credentials consumed by that smoke, so only ordered
# validated env files can supply them. EVENT_CLIPS_ENABLED retains its separate
# normal/default and emergency-override ownership contract.
controlled_compose() (
  unset EVENT_CLIPS_ENABLED FRONT_ORIGINS AUTH_COOKIE_SAME_SITE AUTH_COOKIE_SECURE
  unset SUPER_ADMIN_EMAIL SUPER_ADMIN_PASSWORD
  "$@"
)

# Capture the producer before inspecting exact-line output so a producer that
# emits plausible bytes and then fails cannot be masked by the membership test.
controlled_command_has_exact_line() (
  expected_line=$1
  shift
  [ "$#" -gt 0 ] || return 2
  if command_output=$("$@"); then
    :
  else
    command_status=$?
    return "$command_status"
  fi
  printf '%s\n' "$command_output" | grep -Fx "$expected_line" >/dev/null
)

# Support both sourcing as a shared function and direct command wrapping.
if [ "${0##*/}" = controlled-compose.sh ]; then
  [ "$#" -gt 0 ] || exit 2
  controlled_compose "$@"
fi
