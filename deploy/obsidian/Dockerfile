FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

WORKDIR /opt/obsidian
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

ENV XDG_CONFIG_HOME=/config
USER node
WORKDIR /vault
ENTRYPOINT ["node", "/opt/obsidian/node_modules/obsidian-headless/cli.js"]
CMD ["sync", "--path", "/vault", "--continuous"]
