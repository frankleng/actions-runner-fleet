#!/bin/bash

set -euo pipefail

RUNNER_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_METADATA_PATH="${RUNNER_ROOT}/.runner"
SVC_CMD="${1:-status}"
SYSTEMCTL_BIN="${RUNNER_SYSTEMCTL_BIN:-systemctl}"
UNIT_DIR="${RUNNER_SYSTEMD_USER_DIR:-${HOME}/.config/systemd/user}"

read_runner_json_value() {
  awk -F '"' -v field_name="$1" '
    NR == 1 { sub(/^\xef\xbb\xbf/, "") }
    { for (i = 2; i <= NF; i += 2) if ($i == field_name) { print $(i + 2); exit } }
  ' "${RUNNER_METADATA_PATH}"
}

[ -f "${RUNNER_METADATA_PATH}" ] || { echo "runner metadata missing: ${RUNNER_METADATA_PATH}" >&2; exit 1; }
RUNNER_NAME="$(read_runner_json_value agentName)"
GITHUB_URL="$(read_runner_json_value gitHubUrl)"
RUNNER_OWNER="${GITHUB_URL%/}"
RUNNER_OWNER="${RUNNER_OWNER##*/}"
SVC_NAME="actions.runner.${RUNNER_OWNER}.${RUNNER_NAME// /_}"
UNIT_NAME="${SVC_NAME}.service"
UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
TEMPLATE_PATH="${RUNNER_ROOT}/bin/actions.runner.service.template"
CONFIG_PATH="${RUNNER_ROOT}/.service"
CPU_QUOTA_PATH="${RUNNER_ROOT}/.cpu-quota"
DEFAULT_CPU_QUOTA_PERCENT="${RUNNER_DEFAULT_CPU_QUOTA_PERCENT:-200}"

fail() {
  echo "Failed: $*" >&2
  exit 1
}

validate_cpu_quota_percent() {
  local value="$1"

  case "${value}" in
    ''|*[!0-9]*)
      fail "CPU quota must be a whole-number percent (received '${value}')"
      ;;
  esac

  [ "${value}" -ge 1 ] || fail "CPU quota must be at least 1%"
  [ "${value}" -le 100000 ] || fail "CPU quota must not exceed 100000%"
}

read_cpu_quota_percent() {
  local value="${DEFAULT_CPU_QUOTA_PERCENT}"

  if [ -f "${CPU_QUOTA_PATH}" ]; then
    value="$(tr -d '[:space:]' < "${CPU_QUOTA_PATH}")"
  fi

  validate_cpu_quota_percent "${value}"
  printf '%s\n' "${value}"
}

persist_cpu_quota_percent() {
  local value="$1"

  validate_cpu_quota_percent "${value}"
  printf '%s\n' "${value}" > "${CPU_QUOTA_PATH}.tmp"
  mv "${CPU_QUOTA_PATH}.tmp" "${CPU_QUOTA_PATH}"
}

render_service_unit() {
  local cpu_quota_percent

  [ -f "${TEMPLATE_PATH}" ] || fail "service template missing: ${TEMPLATE_PATH}"
  cpu_quota_percent="$(read_cpu_quota_percent)"
  mkdir -p "${UNIT_DIR}"
  sed \
    -e "s#{{RunnerName}}#${RUNNER_NAME}#g" \
    -e "s#{{RunnerRoot}}#${RUNNER_ROOT}#g" \
    -e "s#{{CPUQuotaPercent}}#${cpu_quota_percent}#g" \
    "${TEMPLATE_PATH}" > "${UNIT_PATH}.tmp"
  mv "${UNIT_PATH}.tmp" "${UNIT_PATH}"
}

apply_live_cpu_quota() {
  local cpu_quota_percent="$1"

  if "${SYSTEMCTL_BIN}" --user is-active --quiet "${UNIT_NAME}"; then
    "${SYSTEMCTL_BIN}" --user set-property --runtime \
      "${UNIT_NAME}" "CPUQuota=${cpu_quota_percent}%"
  fi
}

install_service() {
  (cd "${RUNNER_ROOT}" && ./env.sh)
  cp "${RUNNER_ROOT}/bin/runsvc.sh" "${RUNNER_ROOT}/runsvc.sh"
  chmod u+x "${RUNNER_ROOT}/runsvc.sh"
  persist_cpu_quota_percent "$(read_cpu_quota_percent)"
  render_service_unit
  printf '%s\n' "${UNIT_PATH}" > "${CONFIG_PATH}"
  "${SYSTEMCTL_BIN}" --user daemon-reload
  "${SYSTEMCTL_BIN}" --user enable "${UNIT_NAME}"
  apply_live_cpu_quota "$(read_cpu_quota_percent)"
  echo "svc install complete"
}

status_service() {
  echo "status ${SVC_NAME}:"
  echo
  echo "CPU limit: $(read_cpu_quota_percent)%"
  echo
  if [ ! -f "${UNIT_PATH}" ]; then echo "not installed"; echo; return 0; fi
  echo "${UNIT_PATH}"
  echo
  if "${SYSTEMCTL_BIN}" --user is-active --quiet "${UNIT_NAME}"; then
    pid="$("${SYSTEMCTL_BIN}" --user show -p MainPID --value "${UNIT_NAME}")"
    echo "Started:"
    printf '%s 0 %s\n' "${pid}" "${SVC_NAME}"
  else
    echo "Stopped"
  fi
  echo
}

set_cpu_limit() {
  local cpu_quota_percent="${1:-}"

  validate_cpu_quota_percent "${cpu_quota_percent}"
  persist_cpu_quota_percent "${cpu_quota_percent}"

  if [ -f "${UNIT_PATH}" ]; then
    render_service_unit
    "${SYSTEMCTL_BIN}" --user daemon-reload
    apply_live_cpu_quota "${cpu_quota_percent}"
  fi

  echo "CPU limit for ${RUNNER_NAME}: ${cpu_quota_percent}%"
}

case "${SVC_CMD}" in
  install) install_service ;;
  start) [ -f "${UNIT_PATH}" ] || install_service; "${SYSTEMCTL_BIN}" --user start "${UNIT_NAME}"; status_service ;;
  stop) "${SYSTEMCTL_BIN}" --user stop "${UNIT_NAME}" 2>/dev/null || true; status_service ;;
  status) status_service ;;
  set-cpu-limit) set_cpu_limit "${2:-}" ;;
  uninstall) "${SYSTEMCTL_BIN}" --user disable --now "${UNIT_NAME}" 2>/dev/null || true; rm -f "${UNIT_PATH}" "${CONFIG_PATH}"; "${SYSTEMCTL_BIN}" --user daemon-reload ;;
  prune-logs)
    find "${RUNNER_ROOT}/_diag" -type f -mtime "+${RUNNER_LOG_RETENTION_DAYS:-7}" -delete 2>/dev/null || true
    ;;
  *) echo "Usage: ./svc.sh [install|start|stop|status|set-cpu-limit <percent>|uninstall|prune-logs]" >&2; exit 1 ;;
esac
