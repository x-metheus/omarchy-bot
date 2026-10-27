FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956 AS browser
COPY bun /usr/local/bin/bun
COPY runtime /opt/omarchy-bot/runtime
COPY browser-pack /inputs
COPY provision-browser.ts /opt/omarchy-bot/runtime/scripts/container-image/provision-browser.ts
RUN chmod 755 /usr/local/bin/bun \
    && bun /opt/omarchy-bot/runtime/scripts/container-image/provision-browser.ts

FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956
# Ubuntu's base already supplies Bash, flock, coreutils and the system libc.
COPY --from=browser /usr/local/bin/bun /usr/local/bin/bun
COPY runtime /opt/omarchy-bot/runtime
COPY --from=browser /opt/omarchy-bot/browser /opt/omarchy-bot/browser
COPY entrypoint.sh /opt/omarchy-bot/entrypoint.sh
RUN useradd --uid 1000 --home-dir /var/lib/omarchy-bot/home --shell /bin/bash omarchy \
    && mkdir -p /var/lib/omarchy-bot/home /var/lib/omarchy-bot/data /var/lib/omarchy-bot/state \
    && chown -R 1000:1000 /var/lib/omarchy-bot \
    && chmod -R a+rX /opt/omarchy-bot/browser \
    && chmod 700 /var/lib/omarchy-bot /var/lib/omarchy-bot/home /var/lib/omarchy-bot/data /var/lib/omarchy-bot/state \
    && chmod 755 /opt/omarchy-bot/entrypoint.sh
ENV HOME=/var/lib/omarchy-bot/home \
    OMARCHY_BOT_HOME=/var/lib/omarchy-bot/data \
    OMARCHY_BOT_STATE=/var/lib/omarchy-bot/state \
    OMARCHY_BOT_HOST=127.0.0.1 \
    OMARCHY_BOT_BROWSER_PACK_DIR=/opt/omarchy-bot/browser \
    OMARCHY_BOT_PORT=7321
USER 1000:1000
VOLUME ["/var/lib/omarchy-bot"]
EXPOSE 7321
# SIGTERM preserves desktop children for daemon replacement; container stops must flush and close them.
STOPSIGNAL SIGINT
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
    CMD ["bun", "-e", "const tls = !!process.env.OMARCHY_BOT_TLS_CERT; const host = process.env.OMARCHY_BOT_HOST.replace(/^\\[|\\]$/g, ''); const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host; const address = target.includes(':') ? `[${target}]` : target; const r = await fetch(`${tls ? 'https' : 'http'}://${address}:${process.env.OMARCHY_BOT_PORT}/api/health`, {tls: {rejectUnauthorized: false}}); if (!r.ok || (await r.json()).ok !== true) process.exit(1)"]
ENTRYPOINT ["/opt/omarchy-bot/entrypoint.sh"]
