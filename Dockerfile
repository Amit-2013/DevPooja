# Build stage: has the toolchain (python3, make, g++) that node-gyp needs to compile
# better-sqlite3 when no prebuilt binary matches the Node ABI.
FROM node:22-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Deploy guard (Render auto-deploys from this image): sharp's platform binaries
# (@img/*) are npm OPTIONAL dependencies, so a flaked prebuild download is
# silently skipped and require('sharp') throws — mediaVariants then runs
# without WebP variants in production. This is the same root cause as the CI
# phantom failures (root-caused in .github/workflows/node-tests.yml), so the
# Dockerfile carries the identical guard: verify sharp loads, retry the
# install once, and fail the image build if it still will not load — shipping
# a silently degraded app is worse than a failed deploy.
RUN node -e "require('sharp')" \
 || (npm ci --omit=dev \
     && node -e "require('sharp'); console.log('sharp native prebuilds OK (after retry)')")

# Runtime stage: slim image, production dependencies only.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
ENV PORT=3000 DB_PATH=/data/daivikpooja.db UPLOAD_DIR=/data/uploads
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
