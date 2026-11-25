# Bundle-only real-Sway conformance for ticket 04 (Seam 3).
#
# This image is only a test host: Bun, the repository's dependencies, and the
# X11 client fixture. The runtime stage deliberately contains no Sway, grim,
# D-Bus daemon, Xwayland, or compiler, and the suite asserts their absence, so
# a host-tool fallback cannot silently satisfy it.
#
# Sway refuses to run as root, so everything runs as an unprivileged fixture
# user; Bun lives outside /root so that user can execute it.
FROM ubuntu:22.04 AS fixture-builder

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential libx11-dev \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/sway-runtime/conformance/x11-fixture.c /src/x11-fixture.c
RUN mkdir -p /out \
  && cc -O2 -Wall -Wextra -o /out/x11-fixture /src/x11-fixture.c -lX11


FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Only what Bun, the test harness, and the X11 fixture need. No compositor,
# capture tool, bus daemon, X server, or compiler is installed on purpose.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip tar xz-utils libx11-6 \
  && rm -rf /var/lib/apt/lists/*

# Bun 1.4.5 official release digests for the Linux glibc builds.
RUN case "$(uname -m)" in \
      aarch64|arm64) asset=bun-linux-aarch64; checksum=18656a3bf0ea5641f5796ae4213b75255579a70a0fded2f337933785568cdf84 ;; \
      x86_64) \
        if grep -qw avx2 /proc/cpuinfo; then \
          asset=bun-linux-x64; checksum=94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb; \
        else \
          asset=bun-linux-x64-baseline; checksum=dcb23a18a1c2fff12d57bcef696dbbb42eb67fde29f43816ecb595459a24c463; \
        fi ;; \
      *) exit 2 ;; \
    esac \
    && curl -fL --retry 3 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/$asset.zip" -o /tmp/bun.zip \
    && echo "$checksum  /tmp/bun.zip" | sha256sum -c - \
    && unzip -q /tmp/bun.zip -d /opt \
    && ln -s "/opt/$asset/bun" /usr/local/bin/bun \
    && chmod -R a+rX "/opt/$asset" \
    && rm /tmp/bun.zip

COPY --from=fixture-builder /out/x11-fixture /usr/local/bin/x11-fixture

# The Bot Computer must run as an ordinary user, exactly as on a real host.
RUN useradd --create-home --uid 1000 --shell /bin/sh fixture

WORKDIR /app
COPY . /app
RUN bun install --frozen-lockfile \
  && chown -R fixture:fixture /app/node_modules

USER fixture
ENV HOME=/home/fixture

CMD ["bun", "test", "tests/integration/bot-screen-sway-bundle-conformance.test.ts"]
