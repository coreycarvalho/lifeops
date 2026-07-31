# syntax=docker/dockerfile:1

# One image, three commands:
#
#   npm run init     preflight + migrations, runs to completion before the other two start
#   npm run start    the web app (capture box and API)
#   npm run worker   extraction
#
# Not `output: "standalone"`. Standalone prunes node_modules to what Next traced, and the
# worker and the two CLIs run from source through tsx — they need drizzle-orm,
# better-sqlite3, ai and tsx itself, none of which Next traces. One node_modules serving
# three commands is the simple thing, and issue #6 puts image size out of scope.
#
# No model, ever. Inference lives elsewhere on the operator's network (docs/DECISIONS.md),
# so nothing here is sized by model weights.

# Debian 13 (trixie), not 12: better-sqlite3's prebuilt bindings for both architectures are
# linked against GLIBC 2.38, and bookworm ships 2.36. On bookworm the image builds cleanly
# and then dies on first use with `libm.so.6: version GLIBC_2.38 not found`. Keep the base
# and the prebuild on the same side of that line, or set npm_config_build_from_source.
FROM node:24-trixie-slim AS deps
WORKDIR /app
# Nothing leaves the box that does not have to, including at build time.
ENV NEXT_TELEMETRY_DISABLED=1
# better-sqlite3 ships prebuilds for linux/amd64 and linux/arm64 and normally uses one.
# These are the fallback for when it has to compile — build stage only, never in runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

# Separate branch so npm never has to run in the runtime stage.
FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:24-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json package-lock.json next.config.ts tsconfig.json ./
COPY public ./public
# The worker, the preflight check and the migrate CLI all run from source through tsx, and
# tsconfig.json is what resolves their `@/*` imports.
COPY src ./src
# The migrator reads this committed SQL at runtime (drizzle-kit is a devDependency and is
# not here). Without it the stack starts against a database with no tables.
COPY drizzle ./drizzle

# All state lives here, on the one mounted volume. Created and chowned in the image so a
# Docker *named* volume inherits the ownership on first mount; a bind mount does not, which
# is why docs/DEPLOY.md tells you to chown it.
RUN mkdir -p /data && chown node:node /data
ENV LIFEOPS_DB_PATH=/data/lifeops.db

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
