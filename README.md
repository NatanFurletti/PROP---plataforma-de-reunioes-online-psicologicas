# 🧬 PsiConnect - Plataforma de Videochamadas para Psicólogos

![Status](https://img.shields.io/badge/status-em%20desenvolvimento-yellow)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-20%2B-blue)
![React](https://img.shields.io/badge/react-18%2B-61dafb)

> Plataforma web segura e profissional de videochamadas com áudio dedicada a psicólogos para condução de sessões terapêuticas online.

## ✨ Características

- 🎥 **Vídeo e áudio bidirecional** via WebRTC peer-to-peer
- 🔐 **Máxima privacidade** - E2E encryption ready e sem armazenamento de mídia por padrão
- 👥 **Até 2 participantes** - Psicólogo (host) + Paciente (guest)
- 📱 **Interface intuitiva** - Controles básicos de vídeo, áudio e chamada
- 🌐 **Agnóstico de rede** - Suporta TURN/STUN para NAT traversal
- 🔑 **Autenticação segura** - JWT em HTTP-only cookies
- 📊 **Dashboard para psicólogos** - Agendamento e histórico de sessões
- ✅ **LGPD compliant** - Segue regulamentações de proteção de dados

## 🏗️ Stack Tecnológico

### Frontend

- **React 18** + TypeScript
- **Tailwind CSS** para estilização
- **Zustand** para gerenciamento de estado
- **Socket.IO Client** para sinalização em tempo real
- **Vite** como bundler

### Backend

- **Node.js + Express** (TypeScript)
- **PostgreSQL** + Prisma ORM
- **Socket.IO** para WebRTC signaling
- **JWT** para autenticação
- **Zod** para validação de dados

### Infra

- **Docker & Docker Compose**
- **GitHub Actions** para CI/CD
- Suporte a **Coturn** para servidores TURN

## 🚀 Início Rápido

### Com Docker Compose

```bash
git clone <seu-repo>
cd psiconnect/infra
docker-compose up -d
```

Acesse:

- Frontend: http://localhost:5173
- Backend: http://localhost:3333
- PostgreSQL: localhost:5432

### Setup Local

```bash
# Backend
cd backend
npm install
cp .env.example .env
npm run prisma:migrate
npm run dev

# Frontend (outro terminal)
cd frontend
npm install
cp .env.example .env
npm run dev
```

## 📖 Documentação

- [AGENTS.md](./AGENTS.md) - Arquitetura e diretrizes técnicas
- [SETUP.md](./SETUP.md) - Guia de setup completo

## 🔄 Fluxo de Videochamada

```
Psicólogo                 Servidor              Paciente
   (Host)              (Sinalização)              (Guest)
     |                      |                       |
     |--- joinRoom -------->|                       |
     |                      |<-- joinRoom ---------|
     |                      |--- userJoined ----->|
     |--- createOffer ----->|                      |
     |                      |--- offer ----------->|
     |                      |<-- answer ----------|
     |<-- answer ----------|                       |
     |                                             |
     |<========== WebRTC P2P Connection =========>|
```

## 🔐 Segurança

- ✅ **HTTPS/WSS obrigatório** em produção
- ✅ **JWTs em HTTP-only cookies** (protege contra XSS)
- ✅ **CORS configurado** com origin whitelist
- ✅ **Validação com Zod** em todos os inputs
- ✅ **Senhas com bcrypt** (10 rounds)
- ✅ **Sem armazenamento de mídia** por padrão
- ✅ **Princípios LGPD** implementados

## 📊 Endpoints da API

### Autenticação (Public)

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/sessions/join/:token
```

### Sessões (Autenticado)

```
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:id
PATCH  /api/sessions/:id/status
```

## 🗂️ Estrutura do Projeto

```
psiconnect/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Servidor principal
│   │   ├── controllers/          # Handlers HTTP
│   │   ├── services/             # Lógica de negócio
│   │   ├── routes/               # Definição de rotas
│   │   └── socket/               # WebSocket signaling
│   ├── prisma/
│   │   └── schema.prisma         # ORM schema
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
│
├── frontend/
│   ├── src/
│   │   ├── components/           # Componentes React
│   │   ├── pages/                # Pages/Routes
│   │   ├── hooks/                # Custom hooks
│   │   ├── contexts/             # Zustand stores
│   │   ├── services/             # API clients
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── index.css
│   ├── Dockerfile
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
│
├── infra/
│   └── docker-compose.yml
│
├── AGENTS.md                     # Docs técnicas
├── SETUP.md                      # Guia de setup
├── README.md                     # Este arquivo
└── .env.example
```

## 🧑‍💻 Padrões de Código

### TypeScript Strict

```typescript
// ✅ Obrigatório tipagem explícita
interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
}

export const VideoTile = ({
  stream,
  label,
  isMuted = false,
}: VideoTileProps) => {
  // ...
};
```

### Serviços de Negócio

```typescript
// Logic fica em Services, não em Controllers
export class SessionService {
  static async createSession(data: CreateSessionDTO, psychologistId: string) {
    // Validação e lógica aqui
  }
}
```

### Tratamento de Erros

```typescript
// Backend: middleware global
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

// Frontend: erros de WebRTC exibidos ao usuário
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
} catch (error) {
  showUserFriendlyError("Não foi possível acessar a câmera");
}
```

## 🧪 Testes

### Backend

```bash
cd backend
npm run test
npm run test:coverage
```

### Frontend

```bash
cd frontend
npm run test
```

## 📦 Deployment

### Heroku / Railway

```bash
# Certifique-se de ter um Procfile
npm run build
```

### Docker

```bash
docker build -f backend/Dockerfile -t psiconnect-backend ./backend
docker push seu-registry/psiconnect-backend:latest
```

### CI/CD com GitHub Actions

Veja `.github/workflows/` (a ser criado)

## 🤝 Contribuindo

1. Fork o repositório
2. Crie sua feature branch (`git checkout -b feature/MinhaFeature`)
3. Commit suas mudanças (`git commit -am 'Add MinhaFeature'`)
4. Push para o branch (`git push origin feature/MinhaFeature`)
5. Abra um Pull Request

## ⚖️ Regularização

Este projeto segue:

- **LGPD** (Lei Geral de Proteção de Dados - Brasil)
- **CFP Resolução nº 11/2018** (Atendimento online de psicólogos)
- **Health Insurance Portability and Accountability Act (HIPAA)** ready

## 📝 Licença

MIT - veja [LICENSE](./LICENSE) para detalhes.

## 🙏 Agradecimentos

- Comunidade WebRTC
- Socket.IO
- Comunidade React e Node.js

## 📧 Suporte

- 📖 [Documentação](./SETUP.md)
- 🐛 [Issues](https://github.com/seu-repo/issues)
- 💬 [Discussions](https://github.com/seu-repo/discussions)

---

**Desenvolvido com ❤️ para psicólogos que buscam segurança e qualidade no atendimento online.**

_Status: Alpha - Em desenvolvimento ativo_
