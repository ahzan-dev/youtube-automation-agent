# Lumen / AgentTube — production image.
# Playwright's image ships the exact Chromium the locked playwright version
# expects (slideshow rendering) plus fonts and ffmpeg runtime libraries.
FROM mcr.microsoft.com/playwright:v1.54.2-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3456

WORKDIR /app

COPY package.json package-lock.json ./
# ffmpeg-static (optional dep) downloads the Linux binary here; sharp and
# sqlite3 use their prebuilt binaries because the image has no system libvips.
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p data uploads config logs

EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3456/health >/dev/null || exit 1

CMD ["node", "index.js"]
