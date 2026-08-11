#!/usr/bin/env sh
set -eu
set +x
HISTFILE=/dev/null
export HISTFILE

TARGET=''
ENV_FILE=''
MANAGED_KEY=''
EMAIL=''
SOURCE_EMAIL=''
PASSWORD_FD=${SUPER_ADMIN_PASSWORD_FD:-0}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage() {
  printf '%s\n' 'Usage: rotate-managed-super-admin.sh --target <ssh-target> --env-file <remote-env> --managed-key senior-ai-lab-primary --email <email> --source-email <email>' >&2
  exit 2
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] && [ -z "$TARGET" ] || usage; TARGET=$2; shift 2 ;;
    --env-file) [ "$#" -ge 2 ] && [ -z "$ENV_FILE" ] || usage; ENV_FILE=$2; shift 2 ;;
    --managed-key) [ "$#" -ge 2 ] && [ -z "$MANAGED_KEY" ] || usage; MANAGED_KEY=$2; shift 2 ;;
    --email) [ "$#" -ge 2 ] && [ -z "$EMAIL" ] || usage; EMAIL=$2; shift 2 ;;
    --source-email) [ "$#" -ge 2 ] && [ -z "$SOURCE_EMAIL" ] || usage; SOURCE_EMAIL=$2; shift 2 ;;
    *) usage ;;
  esac
done

case "$TARGET" in ''|-*|*[!A-Za-z0-9._@:-]*) usage ;; esac
case "$ENV_FILE" in /*) ;; *) fail 'remote environment path must be absolute' ;; esac
[ "$MANAGED_KEY" = senior-ai-lab-primary ] || fail 'managed key is not approved'
case "$EMAIL" in *@*.*) ;; *) fail 'managed email is invalid' ;; esac
case "$SOURCE_EMAIL" in *@*.*) ;; *) fail 'bootstrap source email is invalid' ;; esac
case "$EMAIL$SOURCE_EMAIL" in *[!A-Za-z0-9._@+-]*) fail 'email contains unsupported characters' ;; esac
case "$PASSWORD_FD" in ''|*[!0-9]*) fail 'SUPER_ADMIN_PASSWORD_FD must be a descriptor number' ;; esac
[ -r "/dev/fd/$PASSWORD_FD" ] || fail 'SUPER_ADMIN password descriptor is not readable'
need ssh

# shellcheck disable=SC2016 # Expansion belongs to the privileged remote shell.
REMOTE_SCRIPT='
set -eu
set +x
HISTFILE=/dev/null
export HISTFILE

env_file=$1
managed_key=$2
email=$3
source_email=$4
secret_file=""
next_env=""
env_dir=${env_file%/*}
[ -n "$env_dir" ] || env_dir=/
lock_dir=$env_dir/deploy.lock
lock_held=0

fail() { printf "%s\n" "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing required remote command: $1"; }
cleanup() {
  status=$?
  cleanup_status=0
  if [ -n "$secret_file" ] && [ -e "$secret_file" ]; then
    if ! shred -u "$secret_file"; then rm -f "$secret_file" || cleanup_status=1; fi
  fi
  if [ -n "$next_env" ] && [ -e "$next_env" ] && ! rm -f "$next_env"; then cleanup_status=1; fi
  if [ "$lock_held" -eq 1 ] && ! rmdir "$lock_dir"; then cleanup_status=1; fi
  trap - 0 HUP INT TERM
  [ "$status" -ne 0 ] && exit "$status"
  exit "$cleanup_status"
}

need awk
need cat
need chmod
need grep
need mkdir
need mktemp
need mv
need rm
need rmdir
need sed
need shred
need stat
need tr
need wc
[ ! -L "$env_file" ] && [ -f "$env_file" ] || fail "production environment must be a regular non-symbolic file"
mode=$(stat -c "%a" "$env_file" 2>/dev/null || stat -f "%Lp" "$env_file") || fail "unable to inspect production environment permissions"
case "$mode" in 400|600) ;; *) fail "production environment permissions must be 400 or 600" ;; esac
mkdir "$lock_dir" 2>/dev/null || fail "another managed admin or deployment operation is running"
lock_held=1
trap cleanup 0 HUP INT TERM

umask 077
secret_file=$(mktemp "${TMPDIR:-/tmp}/managed-super-admin-secret.XXXXXX")
cat > "$secret_file"
chmod 600 "$secret_file"
[ -s "$secret_file" ] || fail "SUPER_ADMIN password descriptor is empty"
[ "$(wc -l < "$secret_file" | tr -d " ")" -eq 0 ] || fail "SUPER_ADMIN password must not contain a newline"

next_env=$(mktemp "$env_dir/.managed-super-admin-env.XXXXXX")
awk "index(\$0, \"SUPER_ADMIN_\") != 1 { print }" "$env_file" > "$next_env"
printf "SUPER_ADMIN_MANAGED_KEY=%s\n" "$managed_key" >> "$next_env"
printf "SUPER_ADMIN_EMAIL=%s\n" "$email" >> "$next_env"
printf "SUPER_ADMIN_BOOTSTRAP_SOURCE_EMAIL=%s\n" "$source_email" >> "$next_env"
printf "%s" "SUPER_ADMIN_PASSWORD=\"" >> "$next_env"
sed -e "s/\\\\/\\\\\\\\/g" -e "s/\"/\\\\\"/g" -e "s/\$/\$\$/g" "$secret_file" >> "$next_env"
printf "\"\n" >> "$next_env"
chmod 600 "$next_env"
mv "$next_env" "$env_file"
next_env=""
shred -u "$secret_file"
secret_file=""
printf "MANAGED_SUPER_ADMIN_ENV_UPDATED managedKey=%s\n" "$managed_key"
'

ssh "$TARGET" sudo -n sh -c "$REMOTE_SCRIPT" managed-super-admin-remote \
  "$ENV_FILE" "$MANAGED_KEY" "$EMAIL" "$SOURCE_EMAIL" < "/dev/fd/$PASSWORD_FD"
