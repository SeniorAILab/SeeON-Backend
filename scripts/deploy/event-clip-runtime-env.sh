#!/usr/bin/env sh

# Validate the sole authorized runtime override when present. The caller owns
# error wording so this helper can be shared by deploy entrypoints.
validate_event_clip_runtime_env() {
  runtime_env=$1
  if [ ! -e "$runtime_env" ] && [ ! -L "$runtime_env" ]; then
    return 0
  fi
  [ ! -L "$runtime_env" ] && [ -f "$runtime_env" ] || return 1
  runtime_mode=$(stat -c '%a' "$runtime_env" 2>/dev/null || stat -f '%Lp' "$runtime_env") || return 1
  case "$runtime_mode" in
    400|600) ;;
    *) return 1 ;;
  esac
  printf '%s\n' 'EVENT_CLIPS_ENABLED=false' | cmp -s - "$runtime_env" || return 1
}
