#!/usr/bin/env bash
set -Eeuo pipefail
: "${P0_FAULT:?P0_FAULT is required}"
: "${P0_FORMAL_COUNTER:?P0_FORMAL_COUNTER is required}"
: "${P0_FORMAL_COMMAND:?P0_FORMAL_COMMAND is required}"
candidate_gate() { [[ "$P0_FAULT" != "$1" ]]; }
candidate_gate stage
candidate_gate enospc
candidate_gate hash
candidate_gate start
candidate_gate readiness
candidate_gate log
"$P0_FORMAL_COMMAND" "$P0_FORMAL_COUNTER"
