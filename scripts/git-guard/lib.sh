#!/usr/bin/env sh
# git-guard shared helpers — the SINGLE SOURCE OF TRUTH for all enforcement layers.
#
# Every layer (.githooks/, Claude settings.json hooks, Codex hooks) invokes the
# scripts in this directory; none of them reimplement the logic. Change behavior
# here and it is identical across every actor (Claude, Codex, human) by construction.
#
# POSIX sh. Sourced, not executed.

# Maximum blob size (bytes) allowed in any commit or push.  5 MB = 5 × 1024 × 1024.
# Referenced by deny-assets.sh — change the value here and it takes effect everywhere.
GG_MAX_ASSET_BYTES=5242880

# Colors only on a TTY (keeps hook/CI logs clean).
if [ -t 2 ]; then
  _GG_RED=$(printf '\033[31m')
  _GG_YEL=$(printf '\033[33m')
  _GG_RST=$(printf '\033[0m')
else
  _GG_RED=''
  _GG_YEL=''
  _GG_RST=''
fi

gg_warn() { printf '%s[git-guard] %s%s\n' "$_GG_YEL" "$*" "$_GG_RST" >&2; }
gg_die() {
  printf '%s[git-guard] %s%s\n' "$_GG_RED" "$*" "$_GG_RST" >&2
  exit 1
}

gg_current_branch() { git rev-parse --abbrev-ref HEAD 2>/dev/null; }

# Protected branches, space-separated. GIT_GUARD_PROTECTED overrides the default.
# Set GIT_GUARD_PROTECTED= (empty) to disable enforcement — the documented escape
# hatch for deliberate maintenance on a protected branch.
gg_protected_list() { printf '%s' "${GIT_GUARD_PROTECTED-main}"; }

gg_is_protected() {
  _gg_branch="$1"
  for _gg_p in $(gg_protected_list); do
    if [ "$_gg_branch" = "$_gg_p" ]; then
      return 0
    fi
  done
  return 1
}
