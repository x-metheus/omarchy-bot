FROM rust:1.93.1-bookworm@sha256:1d33950f982ca6411f5e0ee4850be46e03f066f1a9efaeb41922a0e59497c9c2
# Freeze Debian's dependency closure as well as the compiler and JS tooling.
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261020T000000Z bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261020T000000Z bookworm-security main\n' > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev libx11-dev webkit2gtk-driver xvfb dbus-x11 gnome-keyring libsecret-tools libfuse2 patchelf squashfs-tools xauth unzip zstd python3-gi gir1.2-webkit2-4.1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip \
    && echo 'bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c  /tmp/bun.zip' | sha256sum -c - \
    && unzip /tmp/bun.zip -d /tmp \
    && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup CARGO_BUILD_JOBS=4
RUN cargo install tauri-driver --version 2.1.0 --locked \
    && cargo install tauri-cli --version 2.12.4 --locked
ARG linux_app_uid=1000
RUN getent passwd "$linux_app_uid" >/dev/null || useradd --uid "$linux_app_uid" --no-create-home --shell /bin/bash omarchy
WORKDIR /src
