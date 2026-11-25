ARG DISTRO_IMAGE=ubuntu:22.04
FROM ${DISTRO_IMAGE}
ARG FAMILY
# Package managers operate in this disposable image only; no compositor is installed.
RUN case "$FAMILY" in \
      deb) apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends bash ca-certificates curl unzip util-linux gcc libc6-dev libx11-dev libwayland-dev libxkbcommon-dev pkg-config wayland-protocols ;; \
      rpm) dnf install -y bash ca-certificates curl unzip util-linux gcc libX11-devel wayland-devel libxkbcommon-devel pkgconf-pkg-config wayland-protocols-devel ;; \
      arch) pacman -Syu --noconfirm --needed bash ca-certificates curl unzip util-linux gcc libx11 wayland libxkbcommon pkgconf wayland-protocols ;; \
      suse) zypper --non-interactive install bash ca-certificates curl unzip util-linux gcc glibc-devel libX11-devel wayland-devel libxkbcommon-devel pkg-config wayland-protocols-devel ;; \
      alpine) apk add --no-cache bash ca-certificates curl unzip util-linux build-base libx11-dev wayland-dev libxkbcommon-dev pkgconf wayland-protocols libstdc++ ;; \
      *) exit 2 ;; \
    esac
# Bun 1.4.5 official release digests; Alpine uses the native musl build.
RUN if [ "$FAMILY" = alpine ]; then \
      asset=bun-linux-x64-musl; checksum=9b6bdba1fa0914b6adfe48e4438212e2c106d9199b77ba642a9b8a3968a49a59; \
    else \
      asset=bun-linux-x64; checksum=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb; \
    fi \
    && curl -fL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/$asset.zip" -o /tmp/bun.zip \
    && echo "$checksum  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /opt \
    && ln -s "/opt/$asset/bun" /usr/local/bin/bun \
    && rm /tmp/bun.zip \
    && bun --version
COPY scripts/sway-runtime/conformance/x11-fixture.c /tmp/x11-fixture.c
RUN cc -O2 -Wall -Wextra /tmp/x11-fixture.c -lX11 -o /usr/local/bin/x11-fixture \
    && rm /tmp/x11-fixture.c \
    && mkdir -p /home/fixture \
    && chown 1000:1000 /home/fixture \
    && printf 'fixture:x:1000:1000:Fixture:/home/fixture:/bin/bash\n' >> /etc/passwd \
    && printf 'fixture:x:1000:\n' >> /etc/group
USER 1000:1000
ENV HOME=/home/fixture
ENTRYPOINT ["bash", "/src/scripts/distro-conformance/container.sh"]
