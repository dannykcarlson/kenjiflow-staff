# KenjiFlow Staff engine for the client's cloud server. Runs 24/7: bots, recurring
# tasks, approvals and the phone page keep working with every PC off.
# Build and run with deploy/docker-compose.yml (adds Postgres and HTTPS).
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY engine ./engine
COPY renderer ./renderer
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4310 KF_DATA_DIR=/data KF_SERVE_UI=1 KF_TRUST_PROXY=1
EXPOSE 4310
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:4310/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "engine/server.js"]
