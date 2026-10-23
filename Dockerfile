# One image definition for every service:
#   docker build --build-arg SERVICE=generator -t thumbnail-generator/generator .
#   docker build --build-arg SERVICE=scanner   -t thumbnail-generator/scanner .
ARG NODE_IMAGE=node:24-alpine

# Reduce the monorepo to SERVICE and its internal dependencies, split into
# manifests (json/) and sources (full/) so installs cache independently of code.
FROM ${NODE_IMAGE} AS prune
ARG SERVICE
ARG TURBO_VERSION=2.11.10
ENV TURBO_TELEMETRY_DISABLED=1
RUN test -n "$SERVICE" || (echo "--build-arg SERVICE=<generator|scanner> is required" && exit 1)
RUN npm install -g turbo@${TURBO_VERSION}
WORKDIR /app
COPY . .
RUN turbo prune @thumbnail-generator/${SERVICE} --docker

FROM ${NODE_IMAGE} AS build
ARG SERVICE
ENV TURBO_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=prune /app/out/json/ ./
RUN npm ci
COPY --from=prune /app/out/full/ ./
COPY tsconfig.base.json .nvmrc ./
RUN npx turbo run build --filter=@thumbnail-generator/${SERVICE} \
  && npm prune --omit=dev
# Runtime tree: each workspace's manifest, compiled output and any nested deps — no src/tests/configs.
RUN for dir in packages/* services/*; do \
      mkdir -p /deploy/$dir \
      && cp $dir/package.json /deploy/$dir/ \
      && cp -r $dir/dist /deploy/$dir/ \
      && if [ -d $dir/node_modules ]; then cp -r $dir/node_modules /deploy/$dir/; fi; \
    done \
  && cp package.json /deploy/

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
RUN if [ "$SERVICE" = "generator" ]; then apk add --no-cache ffmpeg; fi \
  && addgroup -S app && adduser -S app -G app
WORKDIR /app
ENV NODE_ENV=production \
    SERVICE=${SERVICE}

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /deploy/ ./

USER app
CMD ["sh", "-c", "exec node services/$SERVICE/dist/main.js"]
