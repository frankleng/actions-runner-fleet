#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOTSTRAP_PATH="${RUNNER_BOOTSTRAP_PATH:-${SCRIPT_DIR}/bootstrap.sh}"
RUNNER_TARGET_HELPER_PATH="${RUNNER_TARGET_HELPER_PATH:-${SCRIPT_DIR}/runner-target.sh}"
FLEET_PATH="${RUNNER_FLEET_PATH:-${SCRIPT_DIR}/fleet.tsv}"
REPLACE_EXISTING=0
START_RUNNERS=1
DRY_RUN=0
CHECK_ONLY=0

usage() {
  cat <<'EOF'
Usage:
  ./restore-fleet.sh [options]

Options:
  --replace-existing  Replace GitHub runners that already use the fleet names
  --no-start          Register and provision the fleet without starting it
  --dry-run           Print the restore plan without changing anything
  --check             Verify the host, bundled runner, and fleet manifest
  -h, --help          Show this help

Each fleet.tsv row must explicitly target a GitHub repository, organization, or
enterprise. For interactive setup, the script securely prompts for one
short-lived registration token per token key. For unattended setup, a token key
such as MY_ORG maps to:

  MY_ORG_RUNNER_REGISTRATION_TOKEN
EOF
}

fail() {
  echo "fleet restore failed: $*" >&2
  exit 1
}

[ -r "${RUNNER_TARGET_HELPER_PATH}" ] ||
  fail "runner target helper is missing: ${RUNNER_TARGET_HELPER_PATH}"
# shellcheck source=runner-target.sh
source "${RUNNER_TARGET_HELPER_PATH}"

validate_fleet() {
  local token_key
  local github_url
  local runner_name
  local row_count
  local duplicate_name
  local conflicting_group

  [ -f "${FLEET_PATH}" ] || fail "fleet manifest is missing: ${FLEET_PATH}"
  [ -x "${BOOTSTRAP_PATH}" ] || fail "bootstrap is missing or not executable: ${BOOTSTRAP_PATH}"

  row_count=0
  while IFS=$'\t' read -r token_key github_url runner_name extra; do
    case "${token_key}" in
      ""|\#*)
        continue
        ;;
      *[!A-Z0-9_]*)
        fail "invalid token key in fleet manifest: ${token_key}"
        ;;
    esac
    [ -z "${extra:-}" ] || fail "fleet manifest row has too many columns: ${runner_name}"
    if ! github_runner_scope_from_url "${github_url}" >/dev/null; then
      fail "invalid GitHub repository, organization, or enterprise URL in fleet manifest: ${github_url}"
    fi
    case "${runner_name}" in
      ""|*[!A-Za-z0-9._-]*)
        fail "invalid runner name in fleet manifest: ${runner_name}"
        ;;
    esac
    case "${token_key}${github_url}${runner_name}" in
      *CHANGE_ME*)
        fail "customize fleet.tsv before setup; a row still contains CHANGE_ME"
        ;;
    esac
    row_count="$((row_count + 1))"
  done < "${FLEET_PATH}"

  [ "${row_count}" -gt 0 ] || fail "fleet manifest contains no runners"

  duplicate_name="$(
    awk -F '\t' '
      $1 !~ /^#/ && NF >= 3 {
        count[$3] += 1
        if (count[$3] == 2) {
          print $3
          exit
        }
      }
    ' "${FLEET_PATH}"
  )"
  [ -z "${duplicate_name}" ] || fail "runner name appears more than once in fleet manifest: ${duplicate_name}"

  conflicting_group="$(
    awk -F '\t' '
      $1 !~ /^#/ && NF >= 3 {
        if (($1 in group_url) && group_url[$1] != $2) {
          print $1
          exit
        }
        group_url[$1] = $2
      }
    ' "${FLEET_PATH}"
  )"
  [ -z "${conflicting_group}" ] ||
    fail "token key maps to multiple GitHub target URLs: ${conflicting_group}"
}

report_optional_workflow_host_tools() {
  local developer_directory
  local missing_commands
  local required_command
  local xcode_summary

  missing_commands=""
  for required_command in xcodebuild xcode-select pod swiftc; do
    if ! command -v "${required_command}" >/dev/null 2>&1; then
      missing_commands="${missing_commands} ${required_command}"
    fi
  done

  if [ -n "${missing_commands}" ]; then
    echo "note: optional Apple workflow tools are missing:${missing_commands}; install them only if jobs build Apple software" >&2
    return 0
  fi

  developer_directory="$(xcode-select -p 2>/dev/null || true)"
  if [ -z "${developer_directory}" ] || [ ! -d "${developer_directory}" ]; then
    echo "note: Xcode is installed but its active developer directory is not configured" >&2
    return 0
  fi

  xcode_summary="$(xcodebuild -version 2>/dev/null | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  echo "optional Apple workflow tools: ${xcode_summary}; CocoaPods $(pod --version)"
}

report_disk_headroom() {
  local available_kib
  local runner_count
  local recommended_kib

  runner_count="$(
    awk -F '\t' '$1 !~ /^#/ && NF >= 3 { count += 1 } END { print count + 0 }' "${FLEET_PATH}"
  )"
  available_kib="$(df -Pk "${SCRIPT_DIR}" | awk 'NR == 2 { print $4 }')"
  recommended_kib="$(( (10 + (runner_count * 15)) * 1024 * 1024 ))"

  if [ "${available_kib}" -lt "${recommended_kib}" ]; then
    echo "warning: only $(( available_kib / 1024 / 1024 )) GiB is free; the ${runner_count}-runner fleet should have roughly $(( recommended_kib / 1024 / 1024 )) GiB available" >&2
  fi
}

print_fleet() {
  local token_key
  local github_url
  local runner_name
  local scope
  local extra

  printf '  %-12s %-12s %-48s %s\n' "TOKEN KEY" "SCOPE" "GITHUB TARGET" "RUNNER"
  while IFS=$'\t' read -r token_key github_url runner_name extra; do
    case "${token_key}" in
      ""|\#*)
        continue
        ;;
    esac
    scope="$(github_runner_scope_from_url "${github_url}")"
    printf '  %-12s %-12s %-48s %s\n' "${token_key}" "${scope}" "${github_url}" "${runner_name}"
  done < "${FLEET_PATH}"
}

read_registration_token() {
  local token_variable="$1"
  local github_url="$2"
  local registration_token

  registration_token="$(printenv "${token_variable}" 2>/dev/null || true)"
  if [ -n "${registration_token}" ]; then
    printf '%s' "${registration_token}"
    return 0
  fi

  [ -r /dev/tty ] ||
    fail "${token_variable} is required when no interactive terminal is available"

  printf 'Registration token for %s: ' "${github_url}" > /dev/tty
  IFS= read -r -s registration_token < /dev/tty
  printf '\n' > /dev/tty
  [ -n "${registration_token}" ] || fail "registration token cannot be empty"
  printf '%s' "${registration_token}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace-existing)
      REPLACE_EXISTING=1
      shift
      ;;
    --no-start)
      START_RUNNERS=0
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
    *)
      fail "unknown option: $1"
      ;;
  esac
done

validate_fleet
report_optional_workflow_host_tools
report_disk_headroom

if [ "${CHECK_ONLY}" -eq 1 ]; then
  "${BOOTSTRAP_PATH}" --check
  echo "fleet manifest:"
  print_fleet
  exit 0
fi

if [ "${REPLACE_EXISTING}" -eq 1 ]; then
  echo "replacement mode: existing GitHub registrations with these names will be replaced"
else
  echo "fresh mode: existing GitHub registrations with these names must be removed first"
fi

group_rows="$(
  awk -F '\t' '
    $1 !~ /^#/ && NF >= 3 {
      key = $1 SUBSEP $2
      if (!seen[key]++) {
        print $1 "\t" $2
      }
    }
  ' "${FLEET_PATH}"
)"

while IFS=$'\t' read -r token_key github_url; do
  [ -n "${token_key}" ] || continue
  github_scope="$(github_runner_scope_from_url "${github_url}")"
  runner_names=()
  while IFS=$'\t' read -r row_token_key row_github_url runner_name extra; do
    [ "${row_token_key}" = "${token_key}" ] || continue
    [ "${row_github_url}" = "${github_url}" ] || continue
    runner_names+=("${runner_name}")
  done < "${FLEET_PATH}"

  echo
  echo "${github_scope} target ${github_url}: ${#runner_names[@]} runners"

  bootstrap_options=(--url "${github_url}")
  if [ "${REPLACE_EXISTING}" -eq 1 ]; then
    bootstrap_options+=(--replace-existing)
  fi
  if [ "${START_RUNNERS}" -eq 0 ]; then
    bootstrap_options+=(--no-start)
  fi
  if [ "${DRY_RUN}" -eq 1 ]; then
    bootstrap_options+=(--dry-run)
    "${BOOTSTRAP_PATH}" "${bootstrap_options[@]}" "${runner_names[@]}"
    continue
  fi

  token_variable="${token_key}_RUNNER_REGISTRATION_TOKEN"
  registration_token="$(read_registration_token "${token_variable}" "${github_url}")"
  RUNNER_REGISTRATION_TOKEN="${registration_token}" \
    "${BOOTSTRAP_PATH}" "${bootstrap_options[@]}" "${runner_names[@]}"
  registration_token=""
done <<< "${group_rows}"

echo
if [ "${DRY_RUN}" -eq 1 ]; then
  echo "fleet restore dry run complete; no registrations, files, or services were changed"
else
  echo "fleet restore complete"
  echo "open the dashboard with: ${SCRIPT_DIR}/runnerctl"
fi
