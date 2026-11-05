#!/bin/bash

# Shared host-to-artifact mapping. Source this file; do not execute it.
# RUNNER_VERSION is the bootstrap version for fresh installs; the autoscale
# controller moves slots to newer verified releases (README: Runner updates).
RUNNER_VERSION="${RUNNER_VERSION:-2.338.2}"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    RUNNER_PLATFORM="macos-arm64"
    RUNNER_ARCHIVE_BASENAME="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
    RUNNER_ARCHIVE_SHA256="25a065af409ffa317ab4d5a3b614dd15fc9c40f2172bc1b35a1b1258e919a388"
    RUNNER_NODE_PLATFORM="darwin-arm64"
    RUNNER_NODE_ARCH="arm64"
    RUNNER_PULUMI_PLATFORM="darwin-arm64"
    RUNNER_SERVICE_MANAGER="launchd"
    RUNNER_SHA256_COMMAND="shasum"
    ;;
  Linux:x86_64)
    RUNNER_PLATFORM="linux-x64"
    RUNNER_ARCHIVE_BASENAME="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
    RUNNER_ARCHIVE_SHA256="baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40"
    RUNNER_NODE_PLATFORM="linux-x64"
    RUNNER_NODE_ARCH="x64"
    RUNNER_PULUMI_PLATFORM="linux-x64"
    RUNNER_SERVICE_MANAGER="systemd-user"
    RUNNER_SHA256_COMMAND="sha256sum"
    ;;
  *)
    echo "unsupported runner host: $(uname -s) $(uname -m); supported: macOS arm64, Linux x86_64" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

RUNNER_ARCHIVE_URL="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${RUNNER_ARCHIVE_BASENAME}"
RUNNER_SERVICE_MANAGER="${RUNNER_SERVICE_MANAGER_OVERRIDE:-${RUNNER_SERVICE_MANAGER}}"

runner_sha256() {
  if [ "${RUNNER_SHA256_COMMAND}" = "shasum" ]; then
    shasum -a 256 "$@"
  else
    sha256sum "$@"
  fi
}

runner_sha256_check() {
  if [ "${RUNNER_SHA256_COMMAND}" = "shasum" ]; then
    shasum -a 256 -c "$@"
  else
    sha256sum -c "$@"
  fi
}
