#!/usr/bin/env sh

# Compose gives inherited process variables precedence over ordered --env-file
# inputs. Run every controlled production invocation without that ambient key so
# the normal default and verified emergency override remain authoritative.
controlled_compose() (
  unset EVENT_CLIPS_ENABLED
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
