FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97
# Freeze Debian's dependency closure as well as the compiler and JS tooling.
RUN rm /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261020T000000Z bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261020T000000Z bookworm-security main\n' > /etc/apt/sources.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libdbus-1-dev libx11-dev webkit2gtk-driver xvfb dbus-x11 gnome-keyring libsecret-tools libfuse2 patchelf squashfs-tools xauth unzip zstd python3-gi gir1.2-webkit2-4.1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-linux-x64.zip \
    && echo '94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb  /tmp/bun.zip' | sha256sum -c - \
    && unzip /tmp/bun.zip -d /tmp \
    && mv /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup CARGO_BUILD_JOBS=3
RUN cargo install tauri-driver --version 2.1.0 --locked \
    && cargo install tauri-cli --version 2.12.4 --locked
ARG linux_app_uid=1000
RUN getent passwd "$linux_app_uid" >/dev/null || useradd --uid "$linux_app_uid" --no-create-home --shell /bin/bash omarchy
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends fuse xdotool && rm -rf /var/lib/apt/lists/*
RUN printf 'omarchy-bot-linux-app-v1\n' > /etc/omarchy-bot-linux-app
