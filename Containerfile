# Alfred on Debian: Node 24, Chrome Headless Shell for render_pdf, CJK fonts so
# Chinese PDFs do not render as boxes, and the mmx CLI for generate_image.
# State and workspace are volumes; credentials come in as podman secrets.
FROM docker.io/library/node:24-bookworm-slim

ENV ALFRED_STATE_DIR=/data/state \
    ALFRED_WORKSPACE=/workspace \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    ALFRED_MMX_BIN=/usr/local/bin/mmx

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && ./node_modules/.bin/playwright-core install --with-deps chromium-headless-shell \
 && npm install -g --no-audit --no-fund mmx-cli@1.0.27 \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*
COPY src ./src

USER node
# mmx reads ~/.mmx/config.json (mounted as a secret) and writes its update check beside it.
RUN mkdir -m 700 /home/node/.mmx
CMD ["node", "src/cli.ts", "run"]
