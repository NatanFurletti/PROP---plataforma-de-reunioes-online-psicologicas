# 🎬 Guia Rápido - Comece Agora

## ⚡ Docker Compose (Recomendado)

```bash
# 1. Entre na pasta infra
cd infra

# 2. Inicie os containers
docker-compose up -d

# 3. Execute as migrações (em novo terminal)
docker-compose exec backend npm run prisma:migrate

# 4. Acesse
# - Frontend: http://localhost:5173
# - Backend: http://localhost:3333
```

---

## 🖥️ Desenvolvimento Local

### Pré-requisitos

- Node.js 20+
- PostgreSQL rodando localmente

### Backend

```bash
cd backend

# 1. Instalar dependências
npm install

# 2. Copiar .env
cp .env.example .env

# 3. Editar .env com seu DATABASE_URL
# DATABASE_URL=postgresql://user:password@localhost:5432/psiconnect

# 4. Gerar Prisma Client
npm run prisma:generate

# 5. Executar migrações
npm run prisma:migrate

# 6. Iniciar servidor
npm run dev
# Deve exibir: 🚀 Server running on http://localhost:3333
```

### Frontend

```bash
cd frontend

# 1. Instalar dependências
npm install

# 2. Copiar .env
cp .env.example .env

# 3. Iniciar desenvolvimento
npm run dev
# Deve exibir: Local: http://localhost:5173
```

---

## 🔑 Credenciais de Teste

### Registrar novo psicólogo

```
POST /api/auth/register
{
  "name": "Dr. João Silva",
  "email": "joao@example.com",
  "password": "senha123456",
  "crp": "12345/SP"
}
```

### Fazer login

```
POST /api/auth/login
{
  "email": "joao@example.com",
  "password": "senha123456"
}
```

### Criar sessão

```
POST /api/sessions
{
  "scheduledAt": "2026-04-01T14:00:00",
  "durationMinutes": 50
}
```

---

## 🐛 Troubleshooting

### Erro: "Porta já em uso"

```bash
# Linux/Mac
lsof -ti:3333 | xargs kill -9
lsof -ti:5173 | xargs kill -9

# Windows
netstat -ano | findstr :3333
taskkill /PID <PID> /F
```

### Erro: "Conexão recusada ao banco"

```bash
# Verifique se PostgreSQL está rodando
psql -U psiconnect -d psiconnect -h localhost

# Com Docker Compose
docker-compose exec postgres psql -U psiconnect -d psiconnect
```

### Erro: "Prisma Client not found"

```bash
cd backend
npm run prisma:generate
npm run prisma:migrate
```

---

## 📊 Endpoints Disponíveis

### 🔓 Públicos

```
POST   /api/auth/register          # Registrar psicólogo
POST   /api/auth/login             # Login
GET    /api/sessions/join/:token   # Validar token de sessão
```

### 🔒 Autenticados (requer JWT)

```
POST   /api/sessions               # Criar sessão
GET    /api/sessions               # Listar minhas sessões
GET    /api/sessions/:id           # Detalhes da sessão
PATCH  /api/sessions/:id/status    # Atualizar status da sessão
POST   /api/auth/logout            # Logout
```

---

## 📁 Estrutura de Arquivos Importantes

```
backend/
├── src/
│   ├── index.ts              👈 Servidor principal
│   ├── controllers/index.ts  👈 Handlers HTTP
│   ├── services/index.ts     👈 Lógica de negócio
│   ├── routes/index.ts       👈 Definição de rotas
│   └── middleware/auth.ts    👈 Auth middleware
└── prisma/
    └── schema.prisma         👈 Modelo de dados

frontend/
├── src/
│   ├── App.tsx               👈 App principal com rotas
│   ├── main.tsx              👈 Entry point
│   ├── hooks/useWebRTC.ts    👈 Hook de WebRTC
│   ├── services/
│   │   ├── api.ts            👈 Cliente HTTP
│   │   └── socket.ts         👈 Cliente WebSocket
│   ├── contexts/useSessionStore.ts  👈 Estado global
│   ├── pages/
│   │   ├── Login.tsx         👈 Página de login
│   │   ├── Dashboard.tsx     👈 Dashboard
│   │   └── VideoCall.tsx     👈 Chamada de vídeo
│   └── components/
│       ├── VideoTile.tsx     👈 Componente de vídeo
│       └── ControlButton.tsx 👈 Botão de controle
```

---

## 🧪 Testes

### Backend

```bash
cd backend
npm run test              # Rodar testes
npm run test:coverage    # Com cobertura
```

### Frontend

```bash
cd frontend
npm run test            # Rodar testes
```

---

## 🚀 Deploy

### Heroku

```bash
# Clonar repo
git clone seu-repo
cd seu-repo

# Cria app Heroku
heroku create psiconnect-app

# Adiciona PostgreSQL
heroku addons:create heroku-postgresql:hobby-dev

# Deploy
git push heroku main

# Rodar migrações
heroku run npm run prisma:migrate -a psiconnect-app
```

### Docker Registry

```bash
# Build images
docker build -f backend/Dockerfile -t seu-registry/psiconnect-backend ./backend
docker build -f frontend/Dockerfile -t seu-registry/psiconnect-frontend ./frontend

# Push
docker push seu-registry/psiconnect-backend:latest
docker push seu-registry/psiconnect-frontend:latest
```

---

## 📞 Suporte

- 📖 Veja [SETUP.md](./SETUP.md) para setup avançado
- 🏗️ Veja [AGENTS.md](./AGENTS.md) para arquitetura técnica
- 📊 Veja [PROJECT_STATUS.md](./PROJECT_STATUS.md) para status do projeto
- 🐛 Abra uma issue no GitHub para problemas

---

**Pronto para começar? Execute: `cd infra && docker-compose up -d` 🚀**
