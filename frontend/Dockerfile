# Frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Frontend Runtime
FROM node:20-alpine

WORKDIR /app

RUN npm install -g serve

COPY --from=frontend-builder /app/dist ./dist

EXPOSE 5173

CMD ["serve", "-s", "dist", "-l", "5173"]
