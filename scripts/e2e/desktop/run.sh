#!/bin/bash
# Drive the real desktop binary in disposable containers on a private network:
# the app, an isolated Docker daemon, and a one-node k3s cluster. Nothing here can
# see the host's Docker daemon or its containers. All of it is removed on exit.
#
#   scripts/e2e/desktop/run.sh <peak binary> <tauri-driver> <collectors dir or -> <kubectl> <output dir>
#
# "-" means no collector is supplied: the app has to use the one built into it.
#
# Build the binary so it embeds the frontend:
#   bun run build && cd src-tauri && cargo build --features tauri/custom-protocol
#
# For a plain debug binary, which loads its UI from the dev server (the one `task dev` builds),
# set PEAK_E2E_DIST to the built frontend; it's served on the port that binary expects.
# PEAK_E2E_ONLY=<regex> limits which steps run; NO_K3S=1 skips the cluster, NO_DIND=1 the Docker daemon.
# PEAK_E2E_SCRIPT=cli-discovery.mjs runs the CLI-to-open-app checks; PEAK_E2E_ALT_CLI=<binary> gives them a second build's CLI.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=$(realpath "$1"); DRIVER=$(realpath "$2"); KUBECTL=$(realpath "$4"); OUT=$(realpath -m "$5")
mkdir -p "$OUT"
EXTRA=()
if [ "$3" != "-" ]; then EXTRA+=(-v "$(realpath "$3"):/opt/peak/collectors:ro" -e PEAK_E2E_COLLECTORS=/opt/peak/collectors); fi
if [ -n "${PEAK_E2E_ALT_CLI:-}" ]; then EXTRA+=(-v "$(realpath "$PEAK_E2E_ALT_CLI"):/opt/peak/alt-cli:ro"); fi
if [ -n "${PEAK_E2E_DIST:-}" ]; then EXTRA+=(-v "$(realpath "$PEAK_E2E_DIST"):/opt/peak/dist:ro"); fi
NET=peak-live-net
K3S=rancher/k3s:v1.31.4-k3s1
DIND=docker:27-dind

# These images live on the disk Docker uses. Don't risk filling it.
FREE=$(df --output=avail -BM "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)" 2>/dev/null | tail -1 | tr -dc 0-9 || echo 0)
if [ "${FREE:-0}" -lt 1800 ]; then echo "refusing to start: only ${FREE}M free for Docker" >&2; exit 3; fi

CLI=$(mktemp -d)
chmod 755 "$CLI" # the app runs as another user in its container
stop_containers() {
  docker rm -f -v peak-live-desktop peak-live-dind peak-live-k3s >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
cleanup() {
  stop_containers
  rm -f "$CLI/kubeconfig" "$CLI/docker" "$CLI/kubectl"
  rmdir "$CLI" 2>/dev/null || true
}
trap cleanup EXIT
stop_containers
docker network create "$NET" >/dev/null

if [ -z "${NO_DIND:-}" ]; then
docker run -d -q --name peak-live-dind --network "$NET" --privileged -e DOCKER_TLS_CERTDIR= "$DIND" --host=tcp://0.0.0.0:2375 >/dev/null
for _ in $(seq 1 40); do docker exec peak-live-dind docker info >/dev/null 2>&1 && break; sleep 2; done
fi
if [ -z "${NO_K3S:-}" ]; then
docker run -d -q --name peak-live-k3s --network "$NET" --privileged "$K3S" server --disable=traefik,servicelb --write-kubeconfig-mode=644 --tls-san=peak-live-k3s \
  --kubelet-arg=eviction-hard=nodefs.available\<1%,imagefs.available\<1% >/dev/null
READY=
for _ in $(seq 1 60); do
  if docker exec peak-live-k3s kubectl get nodes 2>/dev/null | grep -q ' Ready'; then READY=1; break; fi
  sleep 3
done
if [ -z "$READY" ]; then docker logs --tail 20 peak-live-k3s >&2; echo "k3s never became ready" >&2; exit 4; fi
docker exec peak-live-k3s cat /etc/rancher/k3s/k3s.yaml | sed 's#https://127.0.0.1:6443#https://peak-live-k3s:6443#' > "$CLI/kubeconfig"
chmod 644 "$CLI/kubeconfig"
fi
cp "$(command -v docker)" "$CLI/docker"
cp "$KUBECTL" "$CLI/kubectl"

docker build -q -t peak-e2e-desktop "$HERE" >/dev/null
docker run --rm --name peak-live-desktop --network "$NET" --init \
  -v "$BIN:/opt/peak/peak:ro" -v "$DRIVER:/opt/peak/tauri-driver:ro" \
  "${EXTRA[@]}" -e PEAK_E2E_ONLY="${PEAK_E2E_ONLY:-}" -e PEAK_E2E_SCRIPT="${PEAK_E2E_SCRIPT:-}" -v "$CLI:/opt/peak/cli:ro" -v "$HERE:/opt/e2e:ro" -v "$OUT:/out" \
  peak-e2e-desktop sh /opt/e2e/inside.sh
