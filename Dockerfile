# node:22-alpine as of 2026-08-15 — node v22.23.2 on Alpine 3.24.1.
# Pinned by digest so two builds of the same git tag produce the same runtime,
# and so a `22-alpine` refresh cannot change musl/OpenSSL under a release that
# nothing re-tests. To move it deliberately:
#   docker buildx imagetools inspect node:22-alpine | head -3
# and replace the digest in BOTH stages with the `Digest:` line it prints.
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no production dependency declares an install hook, so this
# costs nothing and keeps a compromised transitive from executing during the
# build that produces the shipped image. `npm run build` below is explicit.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
RUN apk add --no-cache tini
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
# Honoured by plain Docker, compose, and anything reading OCI healthcheck
# metadata. Azure App Service ignores it — configure its own "Health check"
# feature with path `/` there; see the self-hosting section of the README.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
