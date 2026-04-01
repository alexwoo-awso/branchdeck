FROM node:20.19.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NETLIFY_CLI_VERSION=24.9.0
ENV APP_HOME=/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "netlify-cli@${NETLIFY_CLI_VERSION}" \
  && npm cache clean --force

WORKDIR ${APP_HOME}

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
RUN npm ci --omit=dev
COPY src ./src

RUN useradd --create-home --uid 10001 appuser \
  && chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /workspace/site /workspace/netlify-state /workspace/data \
  && chown -R appuser:appuser ${APP_HOME} /workspace

ENV PORT=8080
ENV REPO_DIR=/workspace/site
ENV NETLIFY_STATE_DIR=/workspace/netlify-state
ENV DATABASE_PATH=/workspace/data/app.db
ENV NETLIFY_PORT=8888
ENV HOME=/home/appuser
ENV NPM_CONFIG_CACHE=/home/appuser/.npm
ENV BROWSER=none

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/docker-entrypoint.sh"]
