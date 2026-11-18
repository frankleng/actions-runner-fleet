# One long-lived container per GitHub organization (see docs/org-containers.md).
#
# systemd is PID 1 so the kit runs inside exactly as on a host: the `runner`
# account lingers, its systemd user manager runs the autoscaler and one service
# per slot, and the system runs its own Docker daemon. Build it with
# `./runnerctl org build ORG`, which supplies the build arguments from
# org-containers.json; nothing here is specific to one organization.
#
# The image carries only the operating system and system libraries. The kit,
# its tools and caches, the runner's home, and Docker's data are bind mounts
# from the host, so a rebuilt image never loses runner state or images.
ARG BASE_IMAGE=ubuntu:26.04
FROM ${BASE_IMAGE}

# Build arguments are not part of the runtime environment (ENV would be).
ARG DEBIAN_FRONTEND=noninteractive
ARG RUNNER_UID=2000
ARG RUNNER_SUDO=1
ARG EXTRA_APT_PACKAGES=""

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# System base, the toolchain jobs expect on an Ubuntu runner, Chromium's system
# libraries (jobs install the browser itself), and Ubuntu's own Docker engine.
# shellcheck disable=SC2086
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session libpam-systemd sudo \
      ca-certificates curl wget gnupg git git-lfs openssh-client gh jq \
      unzip zip xz-utils zstd bzip2 rsync file less locales tzdata \
      procps psmisc lsof iproute2 iputils-ping bind9-dnsutils netcat-openbsd \
      build-essential pkg-config python3 python3-venv python3-pip sqlite3 ffmpeg \
      xvfb xauth fonts-liberation fonts-noto-color-emoji \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 \
      libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libgtk-3-0t64 libnspr4 \
      libnss3 libpango-1.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 \
      libxkbcommon0 libxrandr2 libxshmfence1 \
      docker.io docker-buildx docker-compose-v2 iptables \
      ${EXTRA_APT_PACKAGES} \
 && rm -rf /var/lib/apt/lists/*

# A container has no hardware, consoles, or kernel modules to manage, and its
# network comes from the host: these units would fail or wait for nothing.
RUN systemctl mask \
      systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-udev-trigger.service systemd-modules-load.service systemd-firstboot.service \
      sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
      getty.target console-getty.service systemd-networkd-wait-online.service \
      systemd-timesyncd.service systemd-journald-audit.socket \
 && systemctl enable docker.service containerd.service

# The runner account: a fixed UID per organization (host files under its data
# directory are owned by this UID, never by a host login), lingering so its
# user manager and services start at boot, and in the docker group for the
# org's own daemon. Root in this container is not root on the host under
# Sysbox, so jobs keep passwordless sudo for apt and similar; the privileged
# fallback builds with RUNNER_SUDO=0 because root there is host root.
RUN if getent passwd "${RUNNER_UID}" >/dev/null || getent group "${RUNNER_UID}" >/dev/null; then \
      echo "UID ${RUNNER_UID} is already used in the base image" >&2; exit 1; \
    fi \
 && groupadd --gid "${RUNNER_UID}" runner \
 && useradd --uid "${RUNNER_UID}" --gid runner --groups docker --home-dir /home/runner --no-create-home --shell /bin/bash runner \
 && mkdir -p /var/lib/systemd/linger /etc/runner-org /runner \
 && touch /var/lib/systemd/linger/runner \
 && printf '%s\n' "${RUNNER_UID}" > /etc/runner-org/uid \
 && if [ "${RUNNER_SUDO}" = 1 ]; then \
      printf 'runner ALL=(ALL:ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/runner && chmod 0440 /etc/sudoers.d/runner; \
    fi \
 && printf 'LANG=C.UTF-8\n' > /etc/default/locale

COPY daemon.json /etc/docker/daemon.json
COPY journald.conf /etc/systemd/journald.conf.d/runner-org.conf
COPY user-delegate.conf /etc/systemd/system/user@.service.d/runner-org-delegate.conf
COPY --chmod=0755 runner-org-status /usr/local/bin/runner-org-status

HEALTHCHECK --interval=60s --timeout=15s --start-period=180s --retries=3 \
  CMD ["/usr/local/bin/runner-org-status", "--health"]

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
