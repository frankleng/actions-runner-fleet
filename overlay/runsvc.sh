#!/bin/bash

set -euo pipefail

RUNNER_LOG_PRUNE_INTERVAL_SECONDS="${RUNNER_LOG_PRUNE_INTERVAL_SECONDS:-3600}"
RUNNER_DEFAULT_CPU_QUOTA_PERCENT="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT:-}"
RUNNER_CPU_QUOTA_PATH="${RUNNER_CPU_QUOTA_PATH:-.cpu-quota}"
RUNNER_CPULIMIT_BIN="${RUNNER_CPULIMIT_BIN:-./tools/bin/cpulimit}"
PID=""
PRUNE_PID=""
CPULIMIT_PID=""
CPULIMIT_MONITOR_PID=""
MACOS_CPU_QUOTA_PERCENT=""

shutdown_children() {
  if [ -n "${CPULIMIT_MONITOR_PID}" ]; then
    kill "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
  fi

  if [ -n "${CPULIMIT_PID}" ]; then
    kill "${CPULIMIT_PID}" 2>/dev/null || true
  fi

  if [ -n "${PID}" ]; then
    kill -INT "${PID}" 2>/dev/null || true
  fi

  if [ -n "${PRUNE_PID}" ]; then
    kill "${PRUNE_PID}" 2>/dev/null || true
  fi
}

trap shutdown_children EXIT TERM INT

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

read_cpu_quota_percent() {
  local cpu_quota_percent="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT}"

  if [ -f "${RUNNER_CPU_QUOTA_PATH}" ]; then
    cpu_quota_percent="$(tr -d '[:space:]' < "${RUNNER_CPU_QUOTA_PATH}")"
  elif [ "$(uname -s)" = "Darwin" ]; then
    cpu_quota_percent="$(( $(sysctl -n hw.ncpu) * 50 ))"
  else
    cpu_quota_percent=200
  fi

  case "${cpu_quota_percent}" in
    ''|*[!0-9]*)
      echo "CPU quota must be a whole-number percent (received '${cpu_quota_percent}')" >&2
      exit 1
      ;;
  esac
  [ "${cpu_quota_percent}" -ge 1 ] || {
    echo "CPU quota must be at least 1%" >&2
    exit 1
  }

  printf '%s\n' "${cpu_quota_percent}"
}

process_is_active() {
  local process_state

  process_state="$(ps -o stat= -p "$1" 2>/dev/null | tr -d '[:space:]')"
  [ -n "${process_state}" ] && [[ "${process_state}" != Z* ]]
}

prepare_macos_cpu_limiter() {
  local maximum_percent

  [ "$(uname -s)" = "Darwin" ] || return 0
  [ -x "${RUNNER_CPULIMIT_BIN}" ] || {
    echo "macOS CPU limiter is missing or not executable: ${RUNNER_CPULIMIT_BIN}" >&2
    exit 1
  }

  MACOS_CPU_QUOTA_PERCENT="$(read_cpu_quota_percent)"
  maximum_percent="$(( $(sysctl -n hw.ncpu) * 100 ))"
  [ "${MACOS_CPU_QUOTA_PERCENT}" -le "${maximum_percent}" ] || {
    echo "CPU quota must not exceed ${maximum_percent}% on this Mac" >&2
    exit 1
  }
}

start_macos_cpu_limiter() {
  [ -n "${MACOS_CPU_QUOTA_PERCENT}" ] || return 0

  "${RUNNER_CPULIMIT_BIN}" \
    --limit "${MACOS_CPU_QUOTA_PERCENT}" \
    --include-children \
    --pid "${PID}" &
  CPULIMIT_PID=$!
  sleep 0.1
  if ! process_is_active "${CPULIMIT_PID}"; then
    echo "macOS CPU limiter failed to attach; stopping the runner listener" >&2
    kill -INT "${PID}" 2>/dev/null || true
    wait "${PID}" 2>/dev/null || true
    wait "${CPULIMIT_PID}" 2>/dev/null || true
    PID=""
    CPULIMIT_PID=""
    return 1
  fi

  (
    while process_is_active "${PID}"; do
      if ! process_is_active "${CPULIMIT_PID}"; then
        echo "macOS CPU limiter exited while the runner listener was active; stopping the listener" >&2
        kill -INT "${PID}" 2>/dev/null || true
        exit 1
      fi
      sleep 1
    done
  ) &
  CPULIMIT_MONITOR_PID=$!
}

load_env_file
load_path_file
prepare_macos_cpu_limiter
start_log_pruner

nodever="node20"

./externals/${nodever}/bin/node ./bin/RunnerService.js &
PID=$!
start_macos_cpu_limiter

set +e
wait "${PID}"
listener_exit_code="$?"
set -e

if [ -n "${PRUNE_PID}" ]; then
  kill "${PRUNE_PID}" 2>/dev/null || true
  wait "${PRUNE_PID}" 2>/dev/null || true
fi

if [ -n "${CPULIMIT_MONITOR_PID}" ]; then
  kill "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
  wait "${CPULIMIT_MONITOR_PID}" 2>/dev/null || true
fi

if [ -n "${CPULIMIT_PID}" ]; then
  kill "${CPULIMIT_PID}" 2>/dev/null || true
  wait "${CPULIMIT_PID}" 2>/dev/null || true
fi

trap - EXIT TERM INT
exit "${listener_exit_code}"
