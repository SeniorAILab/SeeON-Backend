# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apk add --no-cache libc6-compat openssl \
  && corepack enable \
  && corepack prepare pnpm@10.32.1 --activate

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --filter backend... --frozen-lockfile

FROM deps AS dev
COPY backend ./backend
WORKDIR /app/backend
EXPOSE 8080

FROM deps AS build
ARG NODE_OPTIONS=--max-old-space-size=1536
ENV NODE_OPTIONS="${NODE_OPTIONS}"
COPY backend ./backend
RUN pnpm --filter backend exec prisma generate \
  && pnpm --filter backend build \
  && pnpm --filter backend exec swc prisma/seed.ts prisma/demo-nokyang.fixture.ts prisma/seed-super-admin.ts src/auth/password.ts -d dist-tools -C module.type=commonjs \
  && pnpm --filter backend deploy --prod --legacy /prod/backend \
  && cp -R /app/backend/prisma /prod/backend/prisma \
  && pnpm --dir /prod/backend exec prisma generate --schema /prod/backend/prisma/schema.prisma

FROM base AS runner
WORKDIR /app/backend
ENV NODE_ENV="production"
ENV PORT="8080"
ARG DEPLOY_SHA
ENV DEPLOY_SHA="${DEPLOY_SHA}"

COPY --from=build /prod/backend/package.json ./package.json
COPY --from=build /prod/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/dist-tools ./dist-tools
COPY --from=build /prod/backend/prisma ./prisma

EXPOSE 8080
# SWC builder compiles sourceRoot (src/) to a flat dist/, so the entry is dist/main
# (matches package.json start:prod). prisma/ + scripts/ are CLI/seed tools, not runtime imports.
CMD ["node", "dist/main"]
