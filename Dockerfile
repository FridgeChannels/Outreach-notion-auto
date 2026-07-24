# Match package-lock playwright version (browsers preinstalled in this image).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NOTION_PROFILE_DIR=/app/profiles/outreach-worker \
    ARTIFACT_DIR=artifacts \
    PLAYWRIGHT_HEADLESS=true \
    TMPDIR=/app/.playwright-tmp \
    TEMP=/app/.playwright-tmp \
    TMP=/app/.playwright-tmp

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/profiles/outreach-worker /app/artifacts /app/data /app/log /app/.playwright-tmp

# Root keeps bind-mounted ./profiles ./data ./artifacts ./log writable on macOS Docker.
CMD ["npx", "tsx", "src/cli.ts"]
