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
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v1.4.4" \
  && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
  && chmod -R a+rX /opt/bun

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
