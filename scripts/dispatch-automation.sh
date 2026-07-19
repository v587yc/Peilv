#!/bin/sh
set -eu
credential_file="${CREDENTIALS_DIRECTORY:?CREDENTIALS_DIRECTORY is not configured}/internal-api-secret"
{
  printf 'url = "http://127.0.0.1:5000/api/automation/dispatch"\n'
  printf 'request = "POST"\nheader = "Content-Type: application/json"\n'
  printf 'data = "{\\"maxTasks\\":1}"\nmax-time = 300\nfail\nsilent\nshow-error\n'
} | /usr/local/libexec/peilv/curl-secret.sh "$credential_file"
