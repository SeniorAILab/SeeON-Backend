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
COPY backend ./backend
RUN pnpm --filter backend exec prisma generate \
  && pnpm --filter backend build \
  && pnpm --filter backend deploy --prod --legacy /prod/backend \
  && PRISMA_SRC="$(echo /app/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma)" \
  && test -d "$PRISMA_SRC" \
  && cp -r "$PRISMA_SRC" /prod/backend/node_modules/.prisma

FROM base AS runner
WORKDIR /app/backend
ENV NODE_ENV="production"
ENV PORT="8080"

COPY --from=build /prod/backend/package.json ./package.json
COPY --from=build /prod/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/backend/prisma ./prisma

EXPOSE 8080
# SWC builder compiles sourceRoot (src/) to a flat dist/, so the entry is dist/main
# (matches package.json start:prod). prisma/ + scripts/ are CLI/seed tools, not runtime imports.
CMD ["node", "dist/main"]
