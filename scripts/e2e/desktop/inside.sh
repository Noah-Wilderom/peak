#!/bin/sh
# Runs inside the disposable container: a local sshd, a virtual display, then the test.
set -eu
# Keys and config for a target reachable with plain `ssh e2e-target`.
su tester -c '
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519
  cp ~/.ssh/id_ed25519.pub ~/.ssh/authorized_keys
  printf "Host e2e-target\n  HostName 127.0.0.1\n  StrictHostKeyChecking accept-new\n" > ~/.ssh/config
'
ssh-keygen -A >/dev/null
/usr/sbin/sshd
chmod 777 /out
if [ -d /opt/peak/dist ]; then
  # A debug binary loads its UI from the dev server's address.
  (cd /opt/peak/dist && python3 -m http.server 1420 --bind 127.0.0.1 >/dev/null 2>&1 &)
fi
exec su --preserve-environment tester -c '
  export HOME=/home/tester USER=tester
  export PATH=/opt/peak:/opt/peak/cli:$PATH OUT=/out
  if [ -n "${PEAK_E2E_COLLECTORS:-}" ]; then export PEAK_COLLECTORS=$PEAK_E2E_COLLECTORS; else unset PEAK_COLLECTORS; fi
  export DOCKER_HOST=tcp://peak-live-dind:2375 KUBECONFIG=/opt/peak/cli/kubeconfig
  export WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 XDG_DATA_HOME=$HOME/.local/share
  cd /opt/e2e
  dbus-run-session -- xvfb-run -a -s "-screen 0 1440x950x24" node "${PEAK_E2E_SCRIPT:-desktop.mjs}"
'
