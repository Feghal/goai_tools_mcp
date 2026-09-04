# goai_tools_mcp/Dockerfile — dev image, keeps devDependencies (jest) so
# `docker compose run web npm test` works without a rebuild.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .

FROM node:20-alpine AS runtime
WORKDIR /app

USER node
COPY --from=build --chown=node:node /app ./

ENV NODE_ENV=development
ENV PORT=3000
EXPOSE 3000

USER root
RUN apk add --no-cache curl && chown -R node:node /app
RUN mkdir -p /data/outputs && chown -R node:node /data
USER node

COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT:-3000}/ || exit 1

CMD ["/app/entrypoint.sh"]
