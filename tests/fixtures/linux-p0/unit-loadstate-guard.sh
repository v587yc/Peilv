#!/usr/bin/env bash

p0_unique_unit_is_absent() {
  local unit="$1" work stdout_file stderr_file stdout_hex stderr_hex expected_stderr_hex status result=1
  [[ "$unit" =~ ^peilv-p0-test-[0-9a-f]{16}\.service$ ]] || return 1

  # Keep untrusted bytes out of Bash variables until od has encoded them. Exact
  # hexadecimal equality rejects NUL, ANSI, non-ASCII, whitespace and multiline
  # variants without relying on Python or locale-sensitive text normalization.
  work="$(mktemp -d "${TMPDIR:-/tmp}/peilv-p0-loadstate-XXXXXXXX")" || return 1
  chmod 0700 "$work" || { rmdir "$work" 2>/dev/null || :; return 1; }
  stdout_file="$work/stdout"
  stderr_file="$work/stderr"
  if systemctl show "$unit" --property=LoadState --value >"$stdout_file" 2>"$stderr_file"; then
    status=0
  else
    status=$?
  fi
  stdout_hex="$(od -An -v -tx1 "$stdout_file")" || stdout_hex=invalid
  stderr_hex="$(od -An -v -tx1 "$stderr_file")" || stderr_hex=invalid
  expected_stderr_hex="$(printf 'Unit %s could not be found.\n' "$unit" | od -An -v -tx1)" || expected_stderr_hex=invalid
  stdout_hex="${stdout_hex//[[:space:]]/}"
  stderr_hex="${stderr_hex//[[:space:]]/}"
  expected_stderr_hex="${expected_stderr_hex//[[:space:]]/}"

  if [[ "$stdout_hex" == 6e6f742d666f756e640a && -z "$stderr_hex" && ( "$status" == 0 || "$status" == 4 ) ]]; then
    result=0
  elif [[ -z "$stdout_hex" && "$stderr_hex" == "$expected_stderr_hex" && "$status" == 4 ]]; then
    result=0
  fi
  rm -f -- "$stdout_file" "$stderr_file" || result=1
  rmdir "$work" || result=1
  return "$result"
}
