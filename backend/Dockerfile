# Prisma precisa de OpenSSL na imagem alpine
FROM node:20-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

# Dependências completas (inclui devDependencies como tsx e typescript)
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npx prisma generate

# Desenvolvimento: usado pelo docker-compose, com src montado como volume
FROM deps AS dev
COPY . .
EXPOSE 3333
CMD ["sh", "-c", "npx prisma migrate deploy && npm run dev"]

# Build de produção
FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime de produção: só dist + dependências de produção.
# O client gerado do Prisma (node_modules/.prisma) sobrevive ao prune.
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 3333
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
