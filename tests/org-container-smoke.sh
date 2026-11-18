#!/bin/bash
# runnerctl org end to end against a stub docker: previews change nothing,
# lifecycle commands refuse unsafe states, and status/stats read each
# container. No real Docker, network, or GitHub access is used.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "${temp_dir}"' EXIT
state="${temp_dir}/state"
mkdir -p "${state}"
log="${temp_dir}/docker.log"
: > "${log}"

cat > "${temp_dir}/docker" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_DOCKER_LOG}"
s="${STUB_DOCKER_STATE}"
case "$1 ${2:-}" in
  "info --format")
    printf '{"ServerVersion":"29.8.1","CgroupVersion":"2","KernelVersion":"7.0.0-34-generic","Runtimes":{"runc":{}%s}}\n' \
      "$([ -e "$s/sysbox" ] && printf ',"sysbox-runc":{}')" ;;
  "image inspect") [ -e "$s/image" ] && echo '[{}]' || exit 1 ;;
  "network inspect")
    [ -e "$s/network" ] || exit 1
    echo '[{"Driver":"bridge","IPAM":{"Config":[{"Subnet":"10.231.1.0/29"}]},"Options":{"com.docker.network.bridge.name":"rf-edgefleetinc"}}]' ;;
  "network create") touch "$s/network"; echo net-id ;;
  "container inspect")
    [ -e "$s/container" ] || exit 1
    printf '[{"State":{"Status":"running","Running":true,"Health":{"Status":"healthy"}},"HostConfig":{"Runtime":"sysbox-runc","NanoCpus":8000000000,"Memory":25769803776},"Config":{"Image":"old","Labels":{}}}]\n' ;;
  "exec runner-org-edgefleetinc")
    printf '{"system":"running","docker":"active","userManager":"active","controller":"active","listeners":2,"jobs":%s}\n' "$(cat "$s/jobs" 2>/dev/null || echo 0)" ;;
  "exec --user"|"exec --interactive")
    [ "$2" = --interactive ] && cat > /dev/null
    case "$*" in
      *"stats --json"*) echo '{"generatedAt":"2026-11-18T00:00:00.000Z","sampleWindowMs":0,"runners":[{"name":"slot-1","status":"active","repository":"-","metrics":{"available":true,"cpuPercent":12,"memoryBytes":1048576,"processCount":3,"uptimeSeconds":60,"disk":{"available":false},"network":{"available":false,"status":"unavailable"}}}]}' ;;
      *) echo "exec $*" ;;
    esac ;;
  "stop --time"|"start runner-org-edgefleetinc"|"create --name"|"rm runner-org-edgefleetinc") ;;
  *) echo "unexpected docker call: $*" >&2; exit 3 ;;
esac
STUB
chmod +x "${temp_dir}/docker"
export RUNNER_DOCKER_BIN="${temp_dir}/docker" STUB_DOCKER_LOG="${log}" STUB_DOCKER_STATE="${state}"

config="${temp_dir}/org-containers.json"
cat > "${config}" <<JSON
{
  "dataRoot": "${temp_dir}/orgs",
  "orgs": {
    "edgefleetinc": { "uid": 2101, "cpus": 2, "memory": "8g", "network": { "subnet": "10.231.1.0/29" } }
  }
}
JSON
org() { "${ROOT_DIR}/runnerctl" org --config "${config}" "$@"; }
fails() { if "$@" > "${temp_dir}/out" 2>&1; then echo "expected failure: $*" >&2; cat "${temp_dir}/out" >&2; exit 1; fi; }

# A config others can write decides what docker runs as root: refused.
chmod 0666 "${config}"
fails org config
grep -q 'only you can write' "${temp_dir}/out"
chmod 0600 "${config}"

# Previews never call docker for changes.
org render edgefleetinc > "${temp_dir}/render"
grep -q -- '--runtime sysbox-runc' "${temp_dir}/render"
grep -q -- 'network create --driver bridge --subnet 10.231.1.0/29' "${temp_dir}/render"
grep -q -- 'source=.*/orgs/edgefleetinc/docker,target=/var/lib/docker' "${temp_dir}/render"
if grep -E -- ' (-e|--env|--env-file|--privileged) ' "${temp_dir}/render"; then echo 'render leaks environment or privilege' >&2; exit 1; fi
org setup-script edgefleetinc > "${temp_dir}/setup.sh"
bash -n "${temp_dir}/setup.sh"
grep -q 'install -d -o 2101 -g 2101 -m 0700' "${temp_dir}/setup.sh"
org create edgefleetinc --dry-run | grep -q '^docker create --name runner-org-edgefleetinc'
org upgrade edgefleetinc --dry-run | grep -q 'autoscale --disable'
if grep -E '^(create|network create|stop|start|rm|build) ' "${log}"; then echo 'a preview changed docker state' >&2; exit 1; fi

# Host check reports what is missing and fails.
fails org check-host
grep -q 'missing sysbox-runc runtime registered' "${temp_dir}/out"

# Create refuses until image, network, data directory, and runtime exist.
fails org create edgefleetinc
grep -q 'is not built' "${temp_dir}/out"
touch "${state}/image"
fails org create edgefleetinc
grep -q 'network runner-org-edgefleetinc does not exist' "${temp_dir}/out"
org network edgefleetinc | grep -q 'created network runner-org-edgefleetinc'
org network edgefleetinc | grep -q 'exists with bridge rf-edgefleetinc'
[ "$(grep -c '^network create' "${log}")" = 1 ]
fails org create edgefleetinc
grep -q 'must exist and belong to uid 2101' "${temp_dir}/out"
if grep -q '^create ' "${log}"; then echo 'create ran despite refusals' >&2; exit 1; fi

# A running container with a job is never stopped without --force.
touch "${state}/container"
echo 1 > "${state}/jobs"
fails org stop edgefleetinc
grep -q 'running 1 job' "${temp_dir}/out"
if grep -q '^stop ' "${log}"; then echo 'stop ran during a job' >&2; exit 1; fi
org stop edgefleetinc --force | grep -q 'stopped runner-org-edgefleetinc'
grep -q '^stop --time 120 runner-org-edgefleetinc' "${log}"
echo 0 > "${state}/jobs"

# Status and stats read each container; stats keeps one row per runner.
org status > "${temp_dir}/status"
grep -q '| edgefleetinc | running | healthy | sysbox-runc | 8 | 24.0 GiB | no | active | active | 2 | 0 |' "${temp_dir}/status"
org status --json | grep -q '"upToDate": false'
RUNNER_STATS_SAMPLE_MS=0 org stats > "${temp_dir}/stats"
grep -q '^| edgefleetinc/slot-1 | active | 12' "${temp_dir}/stats"
grep -q 'RUNNER_STATS_SAMPLE_MS=0 ./runnerctl stats --json' "${log}"

# exec runs as the runner in the kit, with nothing from this shell's environment.
SECRET_SHOULD_NOT_PASS=1 org exec edgefleetinc -- ./runnerctl autoscale --dry-run < /dev/null > /dev/null
tail -1 "${log}" | grep -q '^exec --interactive --user runner --workdir /runner/kit --env XDG_RUNTIME_DIR=/run/user/2101 '
# A token reaches the container on stdin only: never in docker's arguments.
printf 'ghp_stdin_only\n' | org exec edgefleetinc -- sh -c 'umask 077 && cat > .autoscale-token' > /dev/null
if grep -q ghp_stdin_only "${log}"; then echo 'token appeared in docker arguments' >&2; exit 1; fi
if grep -q SECRET_SHOULD_NOT_PASS "${log}"; then echo 'exec passed the caller environment' >&2; exit 1; fi

echo 'org container lifecycle smoke test passed'
