# Lumen / AgentTube — production image.
# Playwright's image ships the exact Chromium the locked playwright version
# expects (slideshow rendering) plus fonts and ffmpeg runtime libraries.
FROM mcr.microsoft.com/playwright:v1.54.2-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=3456 \
    DARKZSEO_PATH=/opt/darkzseo/darkzseo.py

# DarkzSEO 1.4 (optional discoverability preflight). PyPI still ships 1.3.x,
# so take the single-file 1.4 release straight from the tagged commit. It is
# an offline auditor: its only dependencies are beautifulsoup4 and colorama.
ARG DARKZSEO_COMMIT=a6270c512b
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3-bs4 python3-colorama \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/darkzseo \
    && curl -fsSL "https://raw.githubusercontent.com/darkzOGx/darkzseo/${DARKZSEO_COMMIT}/darkzseo.py" -o /opt/darkzseo/darkzseo.py \
    && python3 -c "import ast,sys; ast.parse(open('/opt/darkzseo/darkzseo.py').read())"

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
