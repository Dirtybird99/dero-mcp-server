# dero-mcp-server runtime image — pulls the published npm package and
# runs it in streamable-HTTP mode. Pin DERO_MCP_VERSION at build time to
# control which release ships; default tracks the current major.
#
# Build:
#   VERSION=<published-version>
#   docker build -t dero-mcp-server:${VERSION} --build-arg DERO_MCP_VERSION=${VERSION} .
#
# Run (standalone — Caddy normally fronts this, see docker-compose.yml):
#   docker run --rm -p 8787:8787 \
#     -e DERO_DAEMON_URL=http://your-daemon:10102 \
#     -e DERO_MCP_HTTP_HOST=0.0.0.0 \
#     -e DERO_MCP_ALLOWED_HOSTS=mcp.example.com \
#     -e DERO_MCP_ALLOWED_ORIGINS=app.example.com \
#     dero-mcp-server:${VERSION}

FROM node:22-alpine

ARG DERO_MCP_VERSION=latest

LABEL org.opencontainers.image.title="dero-mcp-server"
LABEL org.opencontainers.image.description="DERO MCP server (streamable HTTP transport)"
LABEL org.opencontainers.image.source="https://github.com/DHEBP/dero-mcp-server"
LABEL org.opencontainers.image.licenses="MIT"

# tini reaps zombies and forwards SIGTERM cleanly to Node.
RUN apk add --no-cache tini && \
    npm install -g --omit=dev "dero-mcp-server@${DERO_MCP_VERSION}" && \
    npm cache clean --force

# Non-root user.
RUN addgroup -S mcp && adduser -S mcp -G mcp
USER mcp
WORKDIR /home/mcp

# Defaults — override at run time via -e flags.
ENV DERO_MCP_HTTP=1 \
    DERO_MCP_HTTP_HOST=0.0.0.0 \
    DERO_MCP_HTTP_PORT=8787 \
    NODE_ENV=production

EXPOSE 8787

# Health check hits /health every 30s. Container is "unhealthy" after
# 3 consecutive failures (90s); reverse proxy can use this signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8787/health" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["dero-mcp-server", "--http"]
