#!/usr/bin/env sh
# Deny irreversible asset uploads: model weights, video/media, and oversized blobs.
# Usage: deny-assets.sh [staged|push]  (default: staged)
#
#   staged — check files added to the index (pre-commit gate)
#   push   — read pre-push stdin and check files added in the outgoing commit range
#
# Escape hatch (intentional exceptions only):
#   GIT_GUARD_ALLOW_ASSETS=1 git <cmd>
set -eu

_gg_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/git-guard/lib.sh
. "$_gg_dir/lib.sh"

mode="${1:-staged}"

# Fast exit — escape hatch for deliberate exceptions.
if [ "${GIT_GUARD_ALLOW_ASSETS:-}" = "1" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Return 0 if the filename matches a denied extension.
_gg_denied_ext() {
  case "$1" in
    # Model weights
    *.pt|*.pth|*.pkl|*.onnx|*.h5|*.safetensors|*.tflite|*.ckpt) return 0 ;;
    # Video / media
    *.mp4|*.avi|*.mov|*.mkv|*.webm) return 0 ;;
  esac
  return 1
}

# Return 0 if the git blob object exceeds the size limit.
_gg_blob_too_large() {
  _gbtl_size=$(git cat-file -s "$1" 2>/dev/null || printf '0')
  [ "${_gbtl_size:-0}" -gt "$GG_MAX_ASSET_BYTES" ]
}

# ---------------------------------------------------------------------------
# Staged mode: files added to the index (pre-commit)
# ---------------------------------------------------------------------------
_gg_staged() {
  files=$(git diff --cached --name-only --diff-filter=A 2>/dev/null || true)
  [ -z "$files" ] && return 0   # nothing added to index — fast exit

  _tmpviol=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$_tmpviol'" EXIT INT TERM

  printf '%s\n' "$files" | while IFS= read -r _f; do
    [ -z "$_f" ] && continue
    if _gg_denied_ext "$_f"; then
      printf '  %s  (denied extension)\n' "$_f" >> "$_tmpviol"
    else
      # Get the staged blob hash and check size.
      _hash=$(git ls-files -s -- "$_f" 2>/dev/null | awk 'NR==1{print $2}')
      if [ -n "$_hash" ] && _gg_blob_too_large "$_hash"; then
        printf '  %s  (exceeds %d bytes — 5 MB limit)\n' "$_f" "$GG_MAX_ASSET_BYTES" >> "$_tmpviol"
      fi
    fi
  done

  if [ -s "$_tmpviol" ]; then
    gg_die "Asset files must not be committed.
Offending files:
$(cat "$_tmpviol")
-> Denied: model weights (*.pt *.pth *.pkl *.onnx *.h5 *.safetensors *.tflite *.ckpt),
           media (*.mp4 *.avi *.mov *.mkv *.webm), and files > 5 MB
-> To bypass intentionally: GIT_GUARD_ALLOW_ASSETS=1 git <cmd>"
  fi
}

# ---------------------------------------------------------------------------
# Push mode: outgoing commits (pre-push, reads from stdin)
# ---------------------------------------------------------------------------
_gg_push() {
  _stdin=$(cat)
  [ -z "$_stdin" ] && return 0   # nothing being pushed — fast exit

  _tmpviol=$(mktemp)
  # shellcheck disable=SC2064
  trap "rm -f '$_tmpviol'" EXIT INT TERM

  printf '%s\n' "$_stdin" | while IFS= read -r _pushline; do
    [ -z "$_pushline" ] && continue
    # Parse pre-push stdin: local_ref local_sha remote_ref remote_sha
    # shellcheck disable=SC2086
    set -- $_pushline
    _local_sha="${2:-}"
    _remote_sha="${4:-}"

    # Skip deletions — local sha is all zeros.
    case "${_local_sha:-}" in
      0000000000000000000000000000000000000000) continue ;;
    esac
    [ -z "$_local_sha" ] && continue

    # Determine the set of commits being pushed.
    if [ "${_remote_sha:-0}" = "0000000000000000000000000000000000000000" ]; then
      # New remote branch — check commits not yet on any remote tracking ref.
      _commits=$(git rev-list "$_local_sha" --not --remotes 2>/dev/null || true)
    else
      # Branch update — check only the new commits.
      _commits=$(git rev-list "$_local_sha" ^"$_remote_sha" 2>/dev/null || true)
    fi
    [ -z "$_commits" ] && continue

    printf '%s\n' "$_commits" | while IFS= read -r _commit; do
      [ -z "$_commit" ] && continue
      # List files added in this commit (name only).
      git diff-tree --no-commit-id -r --name-only --diff-filter=A "$_commit" 2>/dev/null | \
      while IFS= read -r _path; do
        [ -z "$_path" ] && continue
        if _gg_denied_ext "$_path"; then
          printf '  %s  (denied extension, in commit %s)\n' "$_path" "${_commit%"${_commit#???????}"}" >> "$_tmpviol"
        else
          # Resolve blob hash from the commit tree and check size.
          _blob_hash=$(git ls-tree "$_commit" -- "$_path" 2>/dev/null | awk '{print $3}')
          if [ -n "$_blob_hash" ] && _gg_blob_too_large "$_blob_hash"; then
            printf '  %s  (exceeds %d bytes — 5 MB limit, in commit %s)\n' \
              "$_path" "$GG_MAX_ASSET_BYTES" "${_commit%"${_commit#???????}"}" >> "$_tmpviol"
          fi
        fi
      done
    done
  done

  if [ -s "$_tmpviol" ]; then
    gg_die "Asset files must not be pushed.
Offending files:
$(cat "$_tmpviol")
-> Denied: model weights (*.pt *.pth *.pkl *.onnx *.h5 *.safetensors *.tflite *.ckpt),
           media (*.mp4 *.avi *.mov *.mkv *.webm), and files > 5 MB
-> To bypass intentionally: GIT_GUARD_ALLOW_ASSETS=1 git push"
  fi
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
case "$mode" in
  staged) _gg_staged ;;
  push)   _gg_push   ;;
  *) gg_die "deny-assets.sh: unknown mode '$mode' (expected: staged | push)" ;;
esac
