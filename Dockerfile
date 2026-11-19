FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN yarn build && yarn workspaces focus --production

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATABASE_PATH=/data/inboxmux.db \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "dist/cli.js", "serve"]
