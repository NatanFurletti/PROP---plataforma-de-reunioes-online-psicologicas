FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Desenvolvimento: usado pelo docker-compose, com src montado como volume.
# --host para o Vite aceitar conexões de fora do container.
FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# Build de produção. Variáveis VITE_* são embutidas no bundle em tempo de
# build, então precisam chegar como build args.
FROM deps AS build
ARG VITE_API_URL
ARG VITE_SOCKET_URL
ARG VITE_TURN_URL
ARG VITE_TURN_USERNAME
ARG VITE_TURN_CREDENTIAL
COPY . .
RUN npm run build

# Runtime de produção: serve os arquivos estáticos (fallback SPA com -s)
FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm install -g serve@14
COPY --from=build /app/dist ./dist
EXPOSE 5173
USER node
CMD ["serve", "-s", "dist", "-l", "5173"]
