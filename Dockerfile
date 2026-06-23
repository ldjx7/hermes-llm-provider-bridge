FROM node:22-bookworm-slim

ARG INSTALL_CLAUDE=true
ARG CLAUDE_INSTALL_CACHE_BUST=manual

ENV NODE_ENV=production
ENV DISABLE_AUTOUPDATER=1
ENV PATH="/root/.local/bin:${PATH}"
ENV BRIDGE_CONFIG=/config/bridge.config.json
ENV BRIDGE_HOST=0.0.0.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp
RUN echo "CLAUDE_INSTALL_CACHE_BUST=${CLAUDE_INSTALL_CACHE_BUST}" \
  && if [ "$INSTALL_CLAUDE" = "true" ]; then curl -fsSL https://claude.ai/install.sh | bash; fi

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bridge.config.example.json ./bridge.config.example.json
COPY docker-entrypoint.sh ./docker-entrypoint.sh

EXPOSE 18777

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js", "--config", "/config/bridge.config.json"]
