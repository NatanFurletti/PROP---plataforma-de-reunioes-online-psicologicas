# Backend
FROM node:20-alpine AS backend-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Backend Runtime
FROM node:20-alpine

WORKDIR /app

COPY --from=backend-builder /app/package*.json ./
RUN npm ci --only=production

COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/prisma ./prisma

EXPOSE 3333

CMD ["node", "dist/index.js"]
