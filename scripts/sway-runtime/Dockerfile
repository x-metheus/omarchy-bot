# syntax=docker/dockerfile:1
# Build environment for the self-contained Sway runtime bundle.
# The base image digest is pinned; the build itself is scripts/sway-runtime/build.sh.
FROM alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c

# Build-only toolchain.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache \
      build-base meson ninja pkgconf cmake patch tar xz gzip coreutils \
      curl binutils pax-utils \
      wayland-dev wayland-protocols \
      libxkbcommon-dev pixman-dev libdrm-dev libinput-dev libseat-dev \
      eudev-dev hwdata-dev libdisplay-info-dev mesa-dev \
      lcms2-dev libcap-dev libliftoff-dev \
      xcb-util-image-dev xcb-util-renderutil-dev xcb-util-wm-dev libxcb-dev \
      xkeyboard-config-dev xwayland-dev xorgproto xtrans \
      libxcvt-dev libxfont2-dev libxkbfile-dev libmd-dev libtirpc-dev libepoxy-dev \
      expat-dev glib-dev libsm-dev libx11-dev jansson-dev libuv-dev \
      cairo-dev pango-dev json-c-dev pcre2-dev \
      gnutls-dev libjpeg-turbo-dev libwebp-dev fftw-dev zlib-dev \
      linux-headers scdoc basu-dev

# Extra build dependencies kept in their own layer so the main toolchain above
# stays cached when one is added.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache libevdev-dev=1.13.3-r0

# Runtime libraries and data, version-locked to the resolved 3.21.3 index so a
# later repository refresh cannot silently change the bundle. build.sh records
# these in the artifact manifest.
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache \
      mesa=24.2.8-r0 libdrm=2.4.123-r1 libinput=1.27.0-r0 libevdev=1.13.3-r0 libxkbcommon=1.7.0-r1 \
      pixman=0.43.4-r1 wayland=1.23.1-r0 wayland-protocols=1.38-r0 \
      xkeyboard-config=2.43-r0 xkbcomp=1.5.0-r0 libdisplay-info=0.2.0-r0 \
      libseat=0.9.1-r0 eudev=3.2.14-r5 libcap=2.78-r0 json-c=0.18-r0 \
      pcre2=10.43-r1 pango=1.54.0-r1 cairo=1.18.4-r0 gdk-pixbuf=2.42.12-r1 \
      glib=2.82.5-r0 libxcb=1.16.1-r0 xcb-util-wm=0.4.2-r0 \
      xcb-util-renderutil=0.3.10-r0 xcb-util-image=0.4.1-r0 libxcvt=0.1.2-r0 \
      libxfont2=2.0.7-r0 libxkbfile=1.1.3-r0 libmd=1.1.0-r0 libtirpc=1.3.5-r0 \
      libepoxy=1.5.10-r1 libxau=1.0.11-r4 libxdmcp=1.1.5-r1 \
      libxshmfence=1.3.2-r6 libliftoff=0.5.0-r0 lcms2=2.19-r0 zlib=1.3.2-r1 \
      expat=2.9.0-r0 fftw=3.3.10-r6 libjpeg-turbo=3.0.4-r0 libwebp=1.4.0-r0 \
      gnutls=3.8.13-r0 nettle=3.10.2-r0 gmp=6.3.0-r2 p11-kit=0.26.2-r0 \
      libtasn1=4.21.0-r0 dbus=1.14.10-r4 xorg-server-common=21.1.16-r0

WORKDIR /build
