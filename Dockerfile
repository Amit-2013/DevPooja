# Build stage: has the toolchain (python3, make, g++) that node-gyp needs to compile
# better-sqlite3 when no prebuilt binary matches the Node ABI.
FROM node:22-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

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
