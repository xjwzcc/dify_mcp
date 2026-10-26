FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runner
COPY sandbox_runtime/package.json sandbox_runtime/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && ln -s /opt/runner/node_modules/.bin/codex /usr/local/bin/codex \
    && useradd --uid 10001 --create-home agent \
    && mkdir /runs && chown agent:agent /runs
COPY sandbox_runtime/main.py sandbox_runtime/mcp.py sandbox_runtime/models.json ./
USER 10001:10001
CMD ["python3", "/opt/runner/main.py"]
