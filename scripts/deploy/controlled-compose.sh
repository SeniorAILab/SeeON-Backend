#!/usr/bin/env sh

# Compose gives inherited process variables precedence over ordered --env-file
# inputs. Run every controlled production invocation without that ambient key so
# the normal default and verified emergency override remain authoritative.
controlled_compose() (
  unset EVENT_CLIPS_ENABLED
  "$@"
)

# Support both sourcing as a shared function and direct command wrapping.
if [ "${0##*/}" = controlled-compose.sh ]; then
  [ "$#" -gt 0 ] || exit 2
  controlled_compose "$@"
fi
