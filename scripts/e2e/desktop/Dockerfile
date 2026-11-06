# Disposable environment for driving the real Peak desktop binary: WebKitGTK,
# a virtual display, the WebDriver bridge, an sshd to act as a remote target, and a
# real notification daemon. Dunst's D-Bus activation file is removed so the test
# decides when a notification service exists.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-0 webkit2gtk-driver libayatana-appindicator3-1 librsvg2-2 \
      xvfb xauth dbus dbus-x11 ca-certificates dunst \
      openssh-server openssh-client python3 procps fonts-dejavu-core curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar xJ -C /usr/local --strip-components=1 \
    && rm -f /usr/share/dbus-1/services/*dunst* \
    && useradd -m tester && mkdir -p /run/sshd
