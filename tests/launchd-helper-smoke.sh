#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="${ROOT_DIR}/launchd-helper.sh"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "launchd helper smoke test skipped: macOS only"
  exit 0
fi

temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT

account="$(id -un)"
runner_root="/Users/${account}/actions-runner-fleet-example-1"
label="actions.runner.example-org.example-1"

render() {
  sed \
    -e "s#{{SvcName}}#${label}#g" \
    -e "s#{{User}}#${account}#g" \
    -e "s#{{RunnerRoot}}#${runner_root}#g" \
    -e "s#{{[A-Za-z]*}}#/tmp/x#g" \
    "${ROOT_DIR}/overlay/bin/actions.runner.plist.template" > "$1"
}

expect_valid() {
  local output
  output="$(SUDO_USER="${account}" bash "${HELPER}" validate "$1")"
  [ "${output}" = "${label}" ] || { echo "expected $1 to validate as ${label}, got '${output}'" >&2; exit 1; }
}

expect_rejected() {
  local description="$1"
  shift
  if SUDO_USER="${account}" SUDO_UID="$(id -u)" bash "${HELPER}" "$@" >/dev/null 2>&1; then
    echo "expected helper to reject: ${description}" >&2
    exit 1
  fi
}

good="${temp_dir}/good.plist"
render "${good}"
expect_valid "${good}"

variant() {
  local name="$1"
  shift
  cp "${good}" "${temp_dir}/${name}.plist"
  plutil "$@" "${temp_dir}/${name}.plist"
  printf '%s\n' "${temp_dir}/${name}.plist"
}

expect_rejected "root UserName" validate "$(variant root-user -replace UserName -string root)"
expect_rejected "other UserName" validate "$(variant other-user -replace UserName -string someone-else)"
expect_rejected "GroupName key" validate "$(variant group -insert GroupName -string wheel)"
expect_rejected "Program key" validate "$(variant program -insert Program -string /bin/sh)"
expect_rejected "non-runner label" validate "$(variant label -replace Label -string com.apple.evil)"
expect_rejected "label with slash" validate "$(variant slash -replace Label -string actions.runner.a/../../evil)"
expect_rejected "other program" validate "$(variant args -replace ProgramArguments -json '["/bin/sh","-c","id"]')"
expect_rejected "extra argument" validate "$(variant extra-arg -insert ProgramArguments.1 -string --evil)"
relative="$(variant relative -replace WorkingDirectory -string tmp/runner)"
plutil -replace ProgramArguments -json '["tmp/runner/runsvc.sh"]' "${relative}"
expect_rejected "relative workdir" validate "${relative}"
dotdot="$(variant dotdot -replace WorkingDirectory -string /Users/x/../../tmp)"
plutil -replace ProgramArguments -json '["/Users/x/../../tmp/runsvc.sh"]' "${dotdot}"
expect_rejected "dot-dot workdir" validate "${dotdot}"
expect_rejected "non-string environment" validate "$(variant env -replace EnvironmentVariables.PATH -integer 1)"
# Caller-controlled jq definitions must not weaken validation under sudo's kept HOME.
mkdir -p "${temp_dir}/home"
printf 'def test($re): true; def select(f): .;\n' > "${temp_dir}/home/.jq"
evil_label="$(variant jq-home -replace Label -string com.apple.evil)"
if HOME="${temp_dir}/home" SUDO_USER="${account}" bash "${HELPER}" validate "${evil_label}" >/dev/null 2>&1; then
  echo "expected helper to ignore the caller's ~/.jq" >&2
  exit 1
fi
printf 'not a plist' > "${temp_dir}/garbage.plist"
expect_rejected "invalid plist" validate "${temp_dir}/garbage.plist"

if SUDO_USER= SUDO_UID= bash "${HELPER}" check >/dev/null 2>&1; then
  echo "expected check to require sudo" >&2
  exit 1
fi
if SUDO_USER=root SUDO_UID=0 bash "${HELPER}" check >/dev/null 2>&1; then
  echo "expected check to refuse root callers" >&2
  exit 1
fi
SUDO_USER="${account}" SUDO_UID="$(id -u)" bash "${HELPER}" check

expect_rejected "bootstrap outside LaunchDaemons" launchctl bootstrap system "${good}"
expect_rejected "bootstrap traversal" launchctl bootstrap system "/Library/LaunchDaemons/actions.runner.x/../../../tmp/evil.plist"
expect_rejected "bootstrap user domain" launchctl bootstrap "gui/$(id -u)" "/Library/LaunchDaemons/${label}.plist"
expect_rejected "kickstart -k" launchctl kickstart -k "system/${label}"
expect_rejected "non-runner print" launchctl print system/com.apple.sshd
expect_rejected "other user gui bootout" launchctl bootout "gui/0/${label}"
expect_rejected "unload" launchctl unload "/Library/LaunchDaemons/${label}.plist"
expect_rejected "missing daemon kickstart" launchctl kickstart "system/actions.runner.does-not-exist"
expect_rejected "rm system file" rm -f /etc/sudoers
expect_rejected "rm traversal" rm -f "/Library/LaunchDaemons/actions.runner.x/../../../etc/sudoers"
expect_rejected "rm without -f" rm "/Library/LaunchDaemons/${label}.plist"
expect_rejected "install to other path" install -o root -g wheel -m 0644 "${good}"
expect_rejected "install other mode" install -o root -g wheel -m 4755 "${good}" "/Library/LaunchDaemons/${label}.plist"
expect_rejected "unknown command" sh -c id

echo "launchd helper smoke test passed"
