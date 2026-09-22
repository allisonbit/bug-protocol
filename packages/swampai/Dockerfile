# The CLI, in a container, for pipelines where a smoke test of the deployment is one step.
#
# There is no build step and no dependency install, which is why this file is twelve lines:
# the package is plain ESM on the Node standard library. The image is built from the same
# files npm publishes, copied rather than installed, so what runs here is exactly what the
# package contains.
FROM node:22-slim

# Unprivileged, because nothing in this CLI writes anywhere except the config file a caller
# explicitly names with --write.
USER node
WORKDIR /home/node/swamp

COPY --chown=node:node package.json README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src

# Offline self-check at build time. A broken signature check should fail the build rather
# than the first run.
RUN node src/selfcheck.mjs

ENTRYPOINT ["node", "bin/swamp.mjs"]
CMD ["prove"]
