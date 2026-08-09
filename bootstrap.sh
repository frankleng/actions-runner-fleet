#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGE_RUNNERS_PATH="${RUNNER_MANAGE_RUNNERS_PATH:-${SCRIPT_DIR}/manage-runners.sh}"
RUNNER_TARGET_HELPER_PATH="${RUNNER_TARGET_HELPER_PATH:-${SCRIPT_DIR}/runner-target.sh}"
source "${SCRIPT_DIR}/platform.sh"
LAUNCHCTL_BIN="${RUNNER_LAUNCHCTL_BIN:-launchctl}"
REGISTRY_PATH="${RUNNER_REGISTRY_PATH:-${SCRIPT_DIR}/runners.tsv}"
GITHUB_URL="${RUNNER_DEFAULT_URL:-}"
GITHUB_SCOPE=""
RUNNER_ARCHIVE_VERSION="${RUNNER_VERSION}"
RUNNER_ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH:-${SCRIPT_DIR}/${RUNNER_ARCHIVE_BASENAME}}"
RUNNER_DIRECTORY_PREFIX="${RUNNER_DIRECTORY_PREFIX:-}"
START_RUNNERS=1
CHECK_ONLY=0
DRY_RUN=0
REPLACE_EXISTING=0
RUNNER_NAMES=()

usage() {
  cat <<EOF
Usage:
  ./bootstrap.sh [options] <runner-name> [runner-name ...]
  ./bootstrap.sh --check

Options:
  --url URL      GitHub repository, organization, or enterprise target URL.
                 If omitted interactively, the script asks which scope to use.
                 Press Enter to accept the organization default.
                 For unattended setup, this or RUNNER_DEFAULT_URL is required.
  --replace-existing
                 Replace a GitHub runner that already uses the supplied name
  --no-start     Register and provision runners without starting them
  --dry-run      Print the setup plan without changing anything
  --check        Verify that this kit is ready for the current host
  -h, --help     Show this help

Supported target URLs:
  repository    https://github.com/OWNER/REPOSITORY
  organization  https://github.com/ORGANIZATION
  enterprise    https://github.com/enterprises/ENTERPRISE

The script defaults to organization scope, then securely prompts for a GitHub
runner registration token when a new runner must be registered. Choose
repository or enterprise explicitly when organization scope is not appropriate.
New runner installations default to .runners/<runner-name> inside this kit.
For unattended setup, provide the short-lived token in
RUNNER_REGISTRATION_TOKEN.
EOF
}

fail() {
  echo "bootstrap failed: $*" >&2
  exit 1
}

[ -r "${RUNNER_TARGET_HELPER_PATH}" ] ||
  fail "runner target helper is missing: ${RUNNER_TARGET_HELPER_PATH}"
# shellcheck source=runner-target.sh
source "${RUNNER_TARGET_HELPER_PATH}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required command is unavailable: $1"
  fi
}

verify_host() {
  local os_name
  local architecture

  os_name="$(uname -s)"
  architecture="$(uname -m)"

  case "${os_name}:${architecture}" in
    Darwin:arm64|Linux:x86_64) ;;
    *) fail "unsupported host: ${os_name} ${architecture}" ;;
  esac

  for required_command in awk curl df find grep id sleep tar tr "${RUNNER_SHA256_COMMAND}"; do
    require_command "${required_command}"
  done
  if [ "${os_name}" = "Darwin" ]; then
    require_command pkgutil
    require_command sw_vers
    require_command "${LAUNCHCTL_BIN}"
  else
    require_command systemctl
  fi

  [ -x "${MANAGE_RUNNERS_PATH}" ] ||
    fail "runner manager is missing or not executable: ${MANAGE_RUNNERS_PATH}"
  [ -f "${RUNNER_ARCHIVE_PATH}" ] ||
    fail "runner archive is missing: ${RUNNER_ARCHIVE_PATH}"

  local actual_checksum
  actual_checksum="$(runner_sha256 "${RUNNER_ARCHIVE_PATH}" | awk '{print $1}')"
  [ "${actual_checksum}" = "${RUNNER_ARCHIVE_SHA256}" ] ||
    fail "runner archive checksum mismatch"
}

validate_runner_name() {
  local runner_name="$1"

  case "${runner_name}" in
    ""|*[!A-Za-z0-9._-]*)
      fail "runner names may contain only letters, numbers, dots, underscores, and hyphens: ${runner_name}"
      ;;
  esac
}

prompt_for_github_url() {
  local scope_input
  local target

  echo "Choose where GitHub should register these runners:"
  echo "  1) repository   one repository only"
  echo "  2) organization multiple repositories in one organization (default)"
  echo "  3) enterprise   multiple organizations in GitHub Enterprise Cloud"

  while :; do
    IFS= read -r -p "Registration scope [2 - organization]: " scope_input
    scope_input="${scope_input:-${GITHUB_RUNNER_DEFAULT_SCOPE}}"
    if GITHUB_SCOPE="$(github_runner_normalize_scope "${scope_input}")"; then
      break
    fi
    echo "Enter 1/repository, 2/organization, or 3/enterprise." >&2
  done

  while :; do
    case "${GITHUB_SCOPE}" in
      repository)
        IFS= read -r -p "Repository (OWNER/REPOSITORY): " target
        ;;
      organization)
        IFS= read -r -p "Organization name: " target
        ;;
      enterprise)
        IFS= read -r -p "Enterprise slug: " target
        ;;
    esac

    if GITHUB_URL="$(github_runner_url_from_scope_and_target "${GITHUB_SCOPE}" "${target}")"; then
      break
    fi
    echo "The target is not valid for the selected ${GITHUB_SCOPE} scope." >&2
  done
}

runner_dir_for_name() {
  local runner_name="$1"
  awk -F '\t' -v name="${runner_name}" '$1 == name { print $2; exit }' "${REGISTRY_PATH}" 2>/dev/null || true
}

default_runner_dir() {
  local runner_name="$1"

  if [ -n "${RUNNER_DIRECTORY_PREFIX}" ]; then
    printf '%s-%s\n' "${RUNNER_DIRECTORY_PREFIX}" "${runner_name}"
    return
  fi

  printf '%s/.runners/%s\n' "${SCRIPT_DIR}" "${runner_name}"
}

runner_is_started() {
  local runner_name="$1"
  local status_output

  status_output="$(
    RUNNER_REGISTRY_PATH="${REGISTRY_PATH}" \
    RUNNER_ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH}" \
    "${MANAGE_RUNNERS_PATH}" status "${runner_name}" 2>&1 ||
      true
  )"
  printf '%s\n' "${status_output}" | grep -q "Started:"
}

enable_runner_service() {
  local runner_name="$1"
  local owner
  local service_name

  if [ "${RUNNER_SERVICE_MANAGER}" != "launchd" ]; then
    return 0
  fi
  owner="${GITHUB_URL%/}"
  owner="${owner##*/}"
  service_name="actions.runner.${owner}.${runner_name// /_}"
  "${LAUNCHCTL_BIN}" enable "gui/$(id -u)/${service_name}" 2>/dev/null || true
}

wait_for_github_connection() {
  local runner_name="$1"
  local runner_dir="$2"
  local attempt

  attempt=1
  while [ "${attempt}" -le 45 ]; do
    if [ -d "${runner_dir}/_diag" ] &&
      grep -R -q --include='Runner_*.log' "Listening for Jobs" "${runner_dir}/_diag" 2>/dev/null; then
      echo "${runner_name}: connected and listening for jobs"
      return 0
    fi
    sleep 1
    attempt="$((attempt + 1))"
  done

  echo "${runner_name}: service started, but 'Listening for Jobs' was not observed within 45 seconds" >&2
  return 1
}

report_disk_headroom() {
  local available_kib
  local runner_count
  local recommended_kib

  available_kib="$(df -Pk "${SCRIPT_DIR}" | awk 'NR == 2 { print $4 }')"
  runner_count="${#RUNNER_NAMES[@]}"
  recommended_kib="$(( (25 + (runner_count * 5)) * 1024 * 1024 ))"

  if [ "${available_kib}" -lt "${recommended_kib}" ]; then
    echo "warning: only $(( available_kib / 1024 / 1024 )) GiB is free; allow roughly 15 GiB of shared tooling plus 5 GiB per runner and 10 GiB of headroom" >&2
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --url)
      [ "$#" -ge 2 ] || fail "--url requires a value"
      GITHUB_URL="$2"
      shift 2
      ;;
    --no-start)
      START_RUNNERS=0
      shift
      ;;
    --replace-existing)
      REPLACE_EXISTING=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      while [ "$#" -gt 0 ]; do
        RUNNER_NAMES+=("$1")
        shift
      done
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      RUNNER_NAMES+=("$1")
      shift
      ;;
  esac
done

verify_host

if [ "${CHECK_ONLY}" -eq 1 ]; then
  echo "portable runner kit is ready"
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "host: $(sw_vers -productName) $(sw_vers -productVersion) ($(uname -m))"
  else
    echo "host: $(. /etc/os-release && echo "${PRETTY_NAME}") ($(uname -m))"
  fi
  echo "runner archive: ${RUNNER_ARCHIVE_VERSION} (checksum verified)"
  echo "registry: ${REGISTRY_PATH}"
  exit 0
fi

[ "${#RUNNER_NAMES[@]}" -gt 0 ] || {
  usage >&2
  exit 1
}

seen_names=" "
for runner_name in "${RUNNER_NAMES[@]}"; do
  validate_runner_name "${runner_name}"
  case "${seen_names}" in
    *" ${runner_name} "*)
      fail "runner name was supplied more than once: ${runner_name}"
      ;;
  esac
  seen_names="${seen_names}${runner_name} "
done

if [ -z "${GITHUB_URL}" ]; then
  [ -t 0 ] ||
    fail "--url is required for unattended setup unless RUNNER_DEFAULT_URL is set"
  prompt_for_github_url
fi

if ! GITHUB_SCOPE="$(github_runner_scope_from_url "${GITHUB_URL}")"; then
  fail "GitHub target must be a repository, organization, or enterprise URL under https://github.com/"
fi

echo "GitHub registration target: ${GITHUB_SCOPE} (${GITHUB_URL%/})"
report_disk_headroom

needs_registration=0
for runner_name in "${RUNNER_NAMES[@]}"; do
  tracked_dir="$(runner_dir_for_name "${runner_name}")"
  if [ -z "${tracked_dir}" ]; then
    needs_registration=1
    tracked_dir="$(default_runner_dir "${runner_name}")"
    if [ "${REPLACE_EXISTING}" -eq 1 ]; then
      action_label="replace"
    else
      action_label="register"
    fi
  else
    action_label="reuse"
  fi
  echo "${action_label}: ${runner_name} -> ${tracked_dir}"
done

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "dry run complete; no files, registrations, or services were changed"
  exit 0
fi

registration_token="${RUNNER_REGISTRATION_TOKEN:-}"
if [ "${needs_registration}" -eq 1 ] && [ -z "${registration_token}" ]; then
  [ -t 0 ] || fail "RUNNER_REGISTRATION_TOKEN is required when standard input is not interactive"
  IFS= read -r -s -p "GitHub ${GITHUB_SCOPE} runner registration token for ${GITHUB_URL%/}: " registration_token
  printf '\n'
fi
trap 'registration_token=""' EXIT

for runner_name in "${RUNNER_NAMES[@]}"; do
  tracked_dir="$(runner_dir_for_name "${runner_name}")"
  if [ -n "${tracked_dir}" ]; then
    [ -f "${tracked_dir}/.runner" ] ||
      fail "tracked runner is missing metadata: ${runner_name} -> ${tracked_dir}"
    continue
  fi

  runner_dir="$(default_runner_dir "${runner_name}")"
  RUNNER_REGISTRY_PATH="${REGISTRY_PATH}" \
  RUNNER_ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH}" \
  RUNNER_DEFER_RECONCILE=1 \
  RUNNER_REPLACE_EXISTING="${REPLACE_EXISTING}" \
    "${MANAGE_RUNNERS_PATH}" register \
      "${runner_name}" \
      "${registration_token}" \
      "${GITHUB_URL}" \
      "${runner_dir}"
done

registration_token=""

for runner_name in "${RUNNER_NAMES[@]}"; do
  runner_dir="$(runner_dir_for_name "${runner_name}")"
  [ -n "${runner_dir}" ] || fail "runner was not added to the local registry: ${runner_name}"

  if [ "${START_RUNNERS}" -eq 0 ]; then
    RUNNER_REGISTRY_PATH="${REGISTRY_PATH}" \
    RUNNER_ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH}" \
      "${MANAGE_RUNNERS_PATH}" reconcile "${runner_name}"
    echo "${runner_name}: provisioned but left stopped"
    continue
  fi

  if runner_is_started "${runner_name}"; then
    echo "${runner_name}: already running"
  else
    enable_runner_service "${runner_name}"
    RUNNER_REGISTRY_PATH="${REGISTRY_PATH}" \
    RUNNER_ARCHIVE_PATH="${RUNNER_ARCHIVE_PATH}" \
      "${MANAGE_RUNNERS_PATH}" start "${runner_name}"
  fi

  wait_for_github_connection "${runner_name}" "${runner_dir}"
done

echo
echo "runner setup complete"
echo "open the auto-refreshing dashboard with: ${SCRIPT_DIR}/runnerctl"
