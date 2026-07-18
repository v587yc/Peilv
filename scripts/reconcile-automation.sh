#!/bin/sh
set -eu

credential_file="${CREDENTIALS_DIRECTORY:?CREDENTIALS_DIRECTORY is not configured}/internal-api-secret"

{
  printf 'url = "http://127.0.0.1:5000/api/automation/reconcile"\n'
  printf 'request = "POST"\n'
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "{}"\n'
  printf 'fail-with-body\n'
  printf 'silent\n'
  printf 'show-error\n'
  printf 'max-time = 330\n'
} | /usr/local/libexec/peilv/curl-secret.sh "$credential_file"
