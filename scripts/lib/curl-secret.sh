#!/bin/sh
unset INTERNAL_API_SECRET INTERNAL_API_SECRET_FILE
set -eu

usage='Usage: curl-secret.sh <credential-file>'
credential_file="${1:?$usage}"
case "$credential_file" in
  /run/credentials/*|/run/peilv/credentials/*|/opt/peilv/shared/credentials/internal-api-secret) ;;
  *) printf 'Credential path is not permitted\n' >&2; exit 1 ;;
esac
if [ ! -f "$credential_file" ] || [ -L "$credential_file" ]; then
  printf 'Credential file is invalid\n' >&2
  exit 1
fi
owner="$(stat -c '%u' "$credential_file")"
mode="$(stat -c '%a' "$credential_file")"
case "$credential_file" in
  /run/credentials/*|/run/peilv/credentials/*)
    [ "$owner" = 0 ] && [ "$mode" = 440 ] || { printf 'Runtime credential must be root-owned 0440\n' >&2; exit 1; }
    ;;
  /opt/peilv/shared/credentials/internal-api-secret)
    [ "$owner" = 0 ] && [ "$mode" = 600 ] || { printf 'Static credential must be root-owned 0600\n' >&2; exit 1; }
    ;;
esac

runtime_dir="${RUNTIME_DIRECTORY:-/run/peilv-probe}"
case "$runtime_dir" in /run/peilv-*|/run/peilv) ;; *) printf 'Runtime directory is not permitted\n' >&2; exit 1 ;; esac
if [ ! -d "$runtime_dir" ] || [ -L "$runtime_dir" ]; then
  printf 'Private runtime directory is unavailable\n' >&2
  exit 1
fi
umask 077
config_file="$(mktemp "$runtime_dir/curl.XXXXXX")"
cleanup() { rm -f -- "$config_file"; }
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
chmod 0600 "$config_file"
cat >"$config_file"
secret="$(cat "$credential_file"; printf _ )"; secret="${secret%_}"
newline="$(printf '\n_')"; newline="${newline%_}"
case "$secret" in *"$newline") secret="${secret%"$newline"}" ;; esac
if [ "${#secret}" -lt 32 ] || [ "${#secret}" -gt 128 ] || [ "$(wc -c <"$credential_file")" -gt 129 ]; then
  printf 'Credential format is invalid\n' >&2
  exit 1
fi
carriage_return="$(printf '\r_')"; carriage_return="${carriage_return%_}"
case "$secret" in *"$newline"*|*"$carriage_return"*) printf 'Credential format is invalid\n' >&2; exit 1 ;; esac
case "$secret" in *[!A-Za-z0-9_-]*) printf 'Credential must use base64url characters\n' >&2; exit 1 ;; esac
escaped_secret="$(printf '%s' "$secret" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf 'header = "x-internal-api-secret: %s"\n' "$escaped_secret" >>"$config_file"
unset secret escaped_secret newline carriage_return
"${CURL_BIN:-/usr/bin/curl}" --config "$config_file"
