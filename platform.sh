#!/bin/bash

# Shared host-to-artifact mapping. Source this file; do not execute it.
RUNNER_VERSION="${RUNNER_VERSION:-2.336.0}"

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    RUNNER_PLATFORM="macos-arm64"
    RUNNER_ARCHIVE_BASENAME="actions-runner-osx-arm64-${RUNNER_VERSION}.tar.gz"
    RUNNER_ARCHIVE_SHA256="8e8839c49b7060b6b2154f4931f815df330c27f167d53ef2239ee3dfce28b079"
    RUNNER_NODE_PLATFORM="darwin-arm64"
    RUNNER_NODE_ARCH="arm64"
    RUNNER_PULUMI_PLATFORM="darwin-arm64"
    RUNNER_SERVICE_MANAGER="launchd"
    RUNNER_SHA256_COMMAND="shasum"
    ;;
  Linux:x86_64)
    RUNNER_PLATFORM="linux-x64"
    RUNNER_ARCHIVE_BASENAME="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
    RUNNER_ARCHIVE_SHA256="04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d"
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
