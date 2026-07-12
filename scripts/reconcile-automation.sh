#!/bin/sh
set -eu

: "${INTERNAL_API_SECRET:?INTERNAL_API_SECRET is not configured}"

{
  printf 'url = "http://127.0.0.1:5000/api/automation/reconcile"\n'
  printf 'request = "POST"\n'
  printf 'header = "Content-Type: application/json"\n'
  printf 'header = "x-internal-api-secret: %s"\n' "$INTERNAL_API_SECRET"
  printf 'data = "{}"\n'
  printf 'fail-with-body\n'
  printf 'silent\n'
  printf 'show-error\n'
  printf 'max-time = 330\n'
} | /usr/bin/curl --config -
