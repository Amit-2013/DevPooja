FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/daivikpooja.db UPLOAD_DIR=/data/uploads
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
