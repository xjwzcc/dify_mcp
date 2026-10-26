FROM node:22-bookworm-slim AS node
FROM python:3.11-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
WORKDIR /app
ENV BRIDGE_DIR=/app/bridge CAPABILITY_REGISTRY=/app/config/capabilities.json
COPY pyproject.toml constraints.txt ./
COPY agent_demo ./agent_demo
COPY bridge ./bridge
COPY config ./config
RUN pip install --no-cache-dir -c constraints.txt '.[fc]' && npm ci --prefix bridge --omit=dev --ignore-scripts --no-audit --no-fund
EXPOSE 8080
CMD ["agent-demo", "serve"]
