#!/bin/bash

set -euo pipefail

RUNNER_LOG_PRUNE_INTERVAL_SECONDS="${RUNNER_LOG_PRUNE_INTERVAL_SECONDS:-3600}"
PID=""
PRUNE_PID=""

shutdown_children() {
  if [ -n "${PID}" ]; then
    kill -INT "${PID}" 2>/dev/null || true
  fi

  if [ -n "${PRUNE_PID}" ]; then
    kill "${PRUNE_PID}" 2>/dev/null || true
  fi
}

trap shutdown_children TERM INT

load_env_file() {
  local env_line

  if [ ! -f ".env" ]; then
    return 0
  fi

  while IFS= read -r env_line; do
    [ -n "${env_line}" ] || continue
    eval "export ${env_line}"
  done < .env
}

load_path_file() {
  if [ -f ".path" ]; then
    export PATH
    PATH="$(cat .path)"
  fi
}

start_log_pruner() {
  case "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" in
    ''|*[!0-9]*)
      echo "RUNNER_LOG_PRUNE_INTERVAL_SECONDS is not a non-negative integer: ${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" >&2
      return 0
      ;;
  esac

  if [ "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}" -eq 0 ] || [ ! -x "./svc.sh" ]; then
    return 0
  fi

  ./svc.sh prune-logs >/dev/null 2>&1 || true

  (
    while true; do
      sleep "${RUNNER_LOG_PRUNE_INTERVAL_SECONDS}"
      ./svc.sh prune-logs >/dev/null 2>&1 || true
    done
  ) &
  PRUNE_PID=$!
}

load_env_file
load_path_file
start_log_pruner

nodever="node20"

./externals/${nodever}/bin/node ./bin/RunnerService.js &
PID=$!

set +e
wait "${PID}"
listener_exit_code="$?"
set -e

if [ -n "${PRUNE_PID}" ]; then
  kill "${PRUNE_PID}" 2>/dev/null || true
  wait "${PRUNE_PID}" 2>/dev/null || true
fi

trap - TERM INT
exit "${listener_exit_code}"
