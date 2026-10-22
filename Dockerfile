# Leash Agent public demo: gateway (L3–L7) + executor + dashboard, against the Avalanche Fuji deployment.
# Secrets come from the environment at runtime (docker compose `env_file: .env`); none are baked into the image.
FROM node:24-bookworm-slim

# OKX Agent Trade Kit for OKX_MODE=atk (demo account). Harmless when OKX is faked.
ARG INSTALL_ATK=1
RUN if [ "$INSTALL_ATK" = "1" ]; then npm install -g @okx_ai/okx-trade-mcp @okx_ai/okx-trade-cli && npm cache clean --force; fi

WORKDIR /app
COPY . .
RUN npm ci && npm cache clean --force && mkdir -p /data && chown -R node:node /data

USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 LEASH_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
CMD ["npx", "tsx", "scripts/fuji-gateway.ts"]
