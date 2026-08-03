#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_TARGET_HELPER_PATH="${RUNNER_TARGET_HELPER_PATH:-${ROOT_DIR}/runner-target.sh}"
REGISTRY_PATH="${RUNNER_REGISTRY_PATH:-${ROOT_DIR}/runners.tsv}"
DEFAULT_URL="${RUNNER_DEFAULT_URL:-}"
ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH:-${ROOT_DIR}/actions-runner-osx-arm64-2.336.0.tar.gz}"
OVERLAY_DIR="${RUNNER_OVERLAY_DIR:-${ROOT_DIR}/overlay}"
PROVISION_SCRIPT_PATH="${RUNNER_PROVISION_SCRIPT_PATH:-${ROOT_DIR}/provision-runner-tooling.sh}"
SELF_NAME="$(basename "${0}")"
RUNNER_PGREP_BIN="${RUNNER_PGREP_BIN:-pgrep}"
RUNNER_PKILL_BIN="${RUNNER_PKILL_BIN:-pkill}"
RUNNER_STOP_GRACE_SECONDS="${RUNNER_STOP_GRACE_SECONDS:-2}"

usage() {
  cat <<EOF
Usage:
  ./${SELF_NAME} help
  ./${SELF_NAME} list
  ./${SELF_NAME} track <name> <runner_dir>
  ./${SELF_NAME} reconcile <name>
  ./${SELF_NAME} reconcile-all
  ./${SELF_NAME} register <name> <token> <target_url> [runner_dir]
  ./${SELF_NAME} install-service <name>
  ./${SELF_NAME} start <name>
  ./${SELF_NAME} stop <name>
  ./${SELF_NAME} status <name>

Notes:
  - ./config.sh is only needed once per new runner directory.
  - After a runner is configured, use ./run.sh or ./svc.sh to start it.
  - Each runner must live in its own directory and have its own name.
  - New runners default to ${ROOT_DIR}/.runners/<runner-name>.
  - Set RUNNER_DEFER_RECONCILE=1 to register quickly and provision later.
  - Set RUNNER_REPLACE_EXISTING=1 to replace a GitHub runner with the same name.
  - Target URLs may identify a repository (OWNER/REPOSITORY), organization
    (ORGANIZATION), or enterprise (enterprises/ENTERPRISE) under github.com.
  - The registry lives at: ${REGISTRY_PATH}
EOF
}

if [ ! -r "${RUNNER_TARGET_HELPER_PATH}" ]; then
  echo "runner target helper is missing: ${RUNNER_TARGET_HELPER_PATH}" >&2
  exit 1
fi
# shellcheck source=runner-target.sh
source "${RUNNER_TARGET_HELPER_PATH}"

ensure_registry() {
  touch "${REGISTRY_PATH}"
}

tracked_runner_rows() {
  ensure_registry
  awk -F '\t' 'NF >= 2 && $1 != "" && $2 != "" { print $1 "\t" $2 }' "${REGISTRY_PATH}"
}

runner_dir_for_name() {
  local name="$1"
  awk -F '\t' -v runner_name="${name}" '$1 == runner_name { print $2; exit }' "${REGISTRY_PATH}"
}

require_runner_dir() {
  local name="$1"
  local runner_dir

  ensure_registry
  runner_dir="$(runner_dir_for_name "${name}")"

  if [ -z "${runner_dir}" ]; then
    echo "runner '${name}' is not tracked in ${REGISTRY_PATH}" >&2
    exit 1
  fi

  if [ ! -d "${runner_dir}" ]; then
    echo "tracked directory does not exist: ${runner_dir}" >&2
    exit 1
  fi

  printf '%s\n' "${runner_dir}"
}

track_runner() {
  local name="$1"
  local runner_dir="$2"

  ensure_registry

  if [ -n "$(runner_dir_for_name "${name}")" ]; then
    echo "runner '${name}' is already tracked" >&2
    exit 1
  fi

  printf '%s\t%s\n' "${name}" "${runner_dir}" >> "${REGISTRY_PATH}"
  echo "tracked ${name} -> ${runner_dir}"
}

list_runners() {
  ensure_registry

  if [ ! -s "${REGISTRY_PATH}" ]; then
    echo "no runners tracked"
    exit 0
  fi

  awk -F '\t' 'BEGIN { printf "%-24s %s\n", "NAME", "DIRECTORY" } { printf "%-24s %s\n", $1, $2 }' "${REGISTRY_PATH}"
}

default_runner_dir() {
  local name="$1"
  local sanitized_name

  sanitized_name="$(printf '%s' "${name}" | tr -cs 'A-Za-z0-9._-' '-')"
  sanitized_name="${sanitized_name#-}"
  sanitized_name="${sanitized_name%-}"
  printf '%s\n' "${ROOT_DIR}/.runners/${sanitized_name}"
}

require_overlay() {
  local overlay_file

  for overlay_file in \
    "${OVERLAY_DIR}/env.sh" \
    "${OVERLAY_DIR}/svc.sh" \
    "${OVERLAY_DIR}/runsvc.sh" \
    "${OVERLAY_DIR}/bin/actions.runner.plist.template"; do
    if [ ! -f "${overlay_file}" ]; then
      echo "managed runner overlay file is missing: ${overlay_file}" >&2
      exit 1
    fi
  done
}

copy_overlay() {
  local runner_dir="$1"

  require_overlay
  mkdir -p "${runner_dir}/bin"
  cp "${OVERLAY_DIR}/env.sh" "${runner_dir}/env.sh"
  cp "${OVERLAY_DIR}/svc.sh" "${runner_dir}/svc.sh"
  cp "${OVERLAY_DIR}/runsvc.sh" "${runner_dir}/bin/runsvc.sh"
  cp "${OVERLAY_DIR}/bin/actions.runner.plist.template" "${runner_dir}/bin/actions.runner.plist.template"
  chmod u+x "${runner_dir}/env.sh" "${runner_dir}/svc.sh" "${runner_dir}/bin/runsvc.sh"
}

ensure_runtime_roots() {
  local runner_dir="$1"

  mkdir -p \
    "${runner_dir}/home/Library/Logs" \
    "${runner_dir}/tmp" \
    "${runner_dir}/_work/_temp" \
    "${runner_dir}/_work/_tool" \
    "${runner_dir}/tools"
}

provision_runner_tooling() {
  local runner_dir="$1"

  if [ ! -x "${PROVISION_SCRIPT_PATH}" ]; then
    echo "provisioning script is not executable: ${PROVISION_SCRIPT_PATH}" >&2
    exit 1
  fi

  "${PROVISION_SCRIPT_PATH}" --root "${runner_dir}"
}

reconcile_runner_dir() {
  local runner_dir="$1"

  if [ ! -d "${runner_dir}" ]; then
    echo "tracked directory does not exist: ${runner_dir}" >&2
    exit 1
  fi

  if [ ! -f "${runner_dir}/.runner" ]; then
    echo "runner metadata not found in ${runner_dir}/.runner" >&2
    exit 1
  fi

  copy_overlay "${runner_dir}"
  ensure_runtime_roots "${runner_dir}"
  provision_runner_tooling "${runner_dir}"

  (
    cd "${runner_dir}"
    ./env.sh
    ./svc.sh install
  )

  echo "reconciled ${runner_dir}"
}

reconcile_runner_name() {
  local name="$1"
  local runner_dir

  runner_dir="$(require_runner_dir "${name}")"
  reconcile_runner_dir "${runner_dir}"
}

wait_for_runner_start() {
  local runner_dir="$1"
  local attempt
  local status_output

  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    status_output="$(
      cd "${runner_dir}" && ./svc.sh status 2>&1 || true
    )"

    if printf '%s\n' "${status_output}" | grep -q "Started:"; then
      return 0
    fi

    sleep 1
  done

  echo "runner did not report started status after reconcile: ${runner_dir}" >&2
  exit 1
}

runner_path_regex() {
  printf '%s' "$1" | sed -e 's/[][(){}.^$*+?|\\]/\\&/g'
}

runner_process_pids() {
  local runner_dir="$1"
  local escaped_runner_dir

  escaped_runner_dir="$(runner_path_regex "${runner_dir}")"

  {
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_dir}/runsvc\\.sh" 2>/dev/null || true
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_dir}/bin/Runner\\.Listener" 2>/dev/null || true
    "${RUNNER_PGREP_BIN}" -f "${escaped_runner_dir}/bin\\.[^/]+/Runner\\.Worker" 2>/dev/null || true
  } | awk 'NF > 0 { print $1 }' | sort -u
}

kill_runner_processes() {
  local runner_dir="$1"
  local signal="$2"
  local escaped_runner_dir

  escaped_runner_dir="$(runner_path_regex "${runner_dir}")"

  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_dir}/runsvc\\.sh" 2>/dev/null || true
  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_dir}/bin/Runner\\.Listener" 2>/dev/null || true
  "${RUNNER_PKILL_BIN}" -"${signal}" -f "${escaped_runner_dir}/bin\\.[^/]+/Runner\\.Worker" 2>/dev/null || true
}

ensure_runner_stopped() {
  local runner_dir="$1"
  local pids

  pids="$(runner_process_pids "${runner_dir}")"
  if [ -z "${pids}" ]; then
    return 0
  fi

  echo "detected lingering runner processes in ${runner_dir}; sending SIGTERM"
  kill_runner_processes "${runner_dir}" TERM
  sleep "${RUNNER_STOP_GRACE_SECONDS}"

  pids="$(runner_process_pids "${runner_dir}")"
  if [ -z "${pids}" ]; then
    echo "runner processes terminated for ${runner_dir}"
    return 0
  fi

  echo "runner processes still alive in ${runner_dir}; sending SIGKILL"
  kill_runner_processes "${runner_dir}" KILL
  sleep 1

  pids="$(runner_process_pids "${runner_dir}")"
  if [ -n "${pids}" ]; then
    echo "failed to stop all runner processes in ${runner_dir}; remaining PIDs: ${pids//$'\n'/ }" >&2
    exit 1
  fi

  echo "runner processes terminated for ${runner_dir}"
}

reconcile_all_runners() {
  local runner_name
  local runner_dir

  while IFS=$'\t' read -r runner_name runner_dir; do
    [ -n "${runner_name}" ] || continue
    [ -n "${runner_dir}" ] || continue

    echo "rolling reconcile for ${runner_name}"
    if [ -x "${runner_dir}/svc.sh" ]; then
      (
        cd "${runner_dir}"
        ./svc.sh stop || true
      )
      ensure_runner_stopped "${runner_dir}"
    fi
    reconcile_runner_dir "${runner_dir}"
    (
      cd "${runner_dir}"
      ./svc.sh start
    )
    wait_for_runner_start "${runner_dir}"
  done < <(tracked_runner_rows)
}

register_runner() {
  local name="$1"
  local token="$2"
  local url="${3:-${DEFAULT_URL}}"
  local runner_dir="${4:-$(default_runner_dir "${name}")}"

  ensure_registry
  [ -n "${url}" ] || {
    echo "GitHub repository, organization, or enterprise URL is required" >&2
    exit 1
  }
  if ! github_runner_scope_from_url "${url}" >/dev/null; then
    echo "GitHub target must be a repository, organization, or enterprise URL under https://github.com/" >&2
    exit 1
  fi

  if [ -n "$(runner_dir_for_name "${name}")" ]; then
    echo "runner '${name}' is already tracked" >&2
    exit 1
  fi

  if [ ! -f "${ARCHIVE_PATH}" ]; then
    echo "runner archive not found: ${ARCHIVE_PATH}" >&2
    exit 1
  fi

  if [ -e "${runner_dir}" ] && [ -n "$(ls -A "${runner_dir}" 2>/dev/null)" ]; then
    echo "target directory is not empty: ${runner_dir}" >&2
    exit 1
  fi

  mkdir -p "${runner_dir}"
  tar -xzf "${ARCHIVE_PATH}" -C "${runner_dir}"

  (
    cd "${runner_dir}"
    config_args=(
      ./config.sh
      --unattended
      --url "${url}"
      --token "${token}"
      --name "${name}"
      --work "_work"
    )
    if [ "${RUNNER_REPLACE_EXISTING:-0}" = "1" ]; then
      config_args+=(--replace)
    fi
    "${config_args[@]}"
  )

  track_runner "${name}" "${runner_dir}"

  if [ "${RUNNER_DEFER_RECONCILE:-0}" = "1" ]; then
    echo "registered ${name}; provisioning deferred"
    return 0
  fi

  reconcile_runner_dir "${runner_dir}"
}

run_service_command() {
  local name="$1"
  local service_command="$2"
  local should_reconcile="${3:-0}"
  local runner_dir

  runner_dir="$(require_runner_dir "${name}")"
  if [ "${should_reconcile}" -eq 1 ]; then
    reconcile_runner_dir "${runner_dir}"
  fi

  (
    cd "${runner_dir}"
    ./svc.sh "${service_command}"
  )

  if [ "${service_command}" = "stop" ]; then
    ensure_runner_stopped "${runner_dir}"
  fi
}

case "${1:-help}" in
  help|-h|--help)
    usage
    ;;
  list)
    list_runners
    ;;
  track)
    if [ "$#" -ne 3 ]; then
      usage
      exit 1
    fi
    track_runner "$2" "$3"
    ;;
  reconcile)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    reconcile_runner_name "$2"
    ;;
  reconcile-all)
    if [ "$#" -ne 1 ]; then
      usage
      exit 1
    fi
    reconcile_all_runners
    ;;
  register)
    if [ "$#" -lt 3 ] || [ "$#" -gt 5 ]; then
      usage
      exit 1
    fi
    register_runner "$2" "$3" "${4:-}" "${5:-}"
    ;;
  install-service)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    run_service_command "$2" install 1
    ;;
  start)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    run_service_command "$2" start 1
    ;;
  stop)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    run_service_command "$2" stop
    ;;
  status)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    run_service_command "$2" status
    ;;
  *)
    usage
    exit 1
    ;;
esac
