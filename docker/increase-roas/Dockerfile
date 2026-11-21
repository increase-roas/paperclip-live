# Increase ROAS image: Paperclip's own `production` image (repo Dockerfile,
# see doc/DOCKER.md) plus the agent toolbox the live paperclip-server image has
# (increase-roas/paperclip-server: python-runtime/Dockerfile).
#
# Built by .github/workflows/ir-image.yml through docker-bake.hcl, which feeds
# the upstream `production` target in as the `paperclip-base` context.
FROM paperclip-base

USER root

# Agent toolbox: Python with pip and venv, build tools. (python3, gh, ripgrep,
# git, curl, jq and openssh-client already come from the upstream image.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3-pip python3-venv build-essential \
  && rm -rf /var/lib/apt/lists/*

# pnpm on the PATH for agents, plus Playwright with its Chromium in a shared
# folder every user can read (same as live).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g --force pnpm@9.15.4 playwright \
  && playwright install --with-deps chromium \
  && chmod -R a+rX /opt/ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# Let agents pip install inside this disposable container without the Debian guard.
ENV PIP_BREAK_SYSTEM_PACKAGES=1

# Same server settings the live image sets.
ENV PAPERCLIP_BIND=lan \
  PAPERCLIP_AUTH_BASE_URL_MODE=explicit \
  PAPERCLIP_PUBLIC_URL=http://localhost:3100

# `paperclipai` CLI on the PATH (live used it for `paperclipai run`, doctor,
# db:backup). Built from this repo's cli package with its own esbuild config.
# The bundle externalizes its npm dependencies, but the production image
# ships only the runtime dependency tree, so link the two packages the CLI
# must resolve at run time (zod via the server, postgres via @paperclipai/db).
RUN cd /app/cli && pnpm run build \
  && ln -s /app/server/node_modules/zod /app/cli/node_modules/zod \
  && ln -s /app/packages/db/node_modules/postgres /app/cli/node_modules/postgres \
  && ln -sf /app/cli/dist/index.js /usr/local/bin/paperclipai \
  && paperclipai --version

COPY docker/increase-roas/ir-entrypoint.sh /usr/local/bin/ir-entrypoint.sh
RUN chmod +x /usr/local/bin/ir-entrypoint.sh

# Increase ROAS 87% app layer (commit e83b7aa109): the UI bundle and the
# bundled server runtime built from this checkout, laid over the exact paths
# the upstream production image serves (/app/ui/dist) and starts
# (/app/server/dist-runtime/index.mjs).
COPY --chown=node:node ui/dist/ /app/ui/dist/
COPY --chown=node:node server/dist-runtime/ /app/server/dist-runtime/

ENTRYPOINT ["/usr/bin/tini", "-s", "--", "ir-entrypoint.sh"]
CMD ["node", "server/dist-runtime/index.mjs"]
