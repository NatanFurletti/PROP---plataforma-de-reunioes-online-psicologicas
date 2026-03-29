# 🚀 Guia de Setup - PsiConnect

## Pré-requisitos

- Node.js 20+
- Docker e Docker Compose (para desenvolvimento com containers)
- Git

## ⚡ Início Rápido

### 1. Clonar o repositório

```bash
git clone <seu-repo>
cd psiconnect
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

### 3. Opção A: Desenvolvimento com Docker Compose

```bash
cd infra
docker-compose up -d
```

Isso inicia:

- PostgreSQL em localhost:5432
- Backend em localhost:3333
- Frontend em localhost:5173

### 3. Opção B: Desenvolvimento local

#### Backend

```bash
cd backend
npm install
npm run prisma:generate

# Crie um arquivo .env com DATABASE_URL apontando ao seu PostgreSQL
# DATABASE_URL=postgresql://user:password@localhost:5432/psiconnect

npm run prisma:migrate
npm run dev
```

#### Frontend

```bash
cd frontend
npm install
npm run dev
```

## 📁 Estrutura do Projeto

```
psiconnect/
├── backend/              # API REST + WebRTC Signaling
│   ├── src/
│   │   ├── index.ts      # Servidor principal
│   │   ├── controllers/  # Lógica de requisições HTTP
│   │   ├── services/     # Lógica de negócio
│   │   ├── routes/       # Definição de rotas
│   │   └── socket/       # WebSocket / Signaling
│   ├── prisma/
│   │   └── schema.prisma # Modelo de dados
│   └── package.json
│
├── frontend/             # Interface React + TypeScript
│   ├── src/
│   │   ├── components/   # Componentes React
│   │   ├── pages/        # Páginas da aplicação
│   │   ├── hooks/        # Custom hooks
│   │   ├── contexts/     # Estado global (Zustand)
│   │   ├── services/     # Chamadas de API e Socket
│   │   └── utils/        # Funções auxiliares
│   └── package.json
│
├── infra/
│   └── docker-compose.yml
│
└── AGENTS.md             # Documentação arquitetura
```

## 🔗 Endpoints principais

### Autenticação

- `POST /api/auth/register` - Registrar psicólogo
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout

### Sessões

- `POST /api/sessions` - Criar sessão
- `GET /api/sessions` - Listar sessões do psicólogo
- `GET /api/sessions/:id` - Detalhes da sessão
- `PATCH /api/sessions/:id/status` - Atualizar status
- `GET /api/sessions/join/:token` - Validar token do paciente

## 🎥 Fluxo WebSocket

O cliente se conecta ao servidor via Socket.IO e segue o fluxo:

1. `join-room` - Entrar na sala de sessão
2. `offer` / `answer` - Troca de SDP para estabelecer WebRTC
3. `ice-candidate` - Enviar candidatos ICE
4. `user-left` / `session-ended` - Encerrar conexão

## 🔐 Segurança

- ✅ Senhas hasheadas com bcrypt
- ✅ JWT em HTTP-only cookies
- ✅ CORS configurado
- ✅ Validação com Zod
- ✅ Sem armazenamento de vídeo/áudio padrão

## 📝 Comandos Úteis

### Backend

```bash
npm run dev           # Desenvolvimento
npm run build         # Build
npm run test          # Testes
npm run prisma:generate   # Gerar Prisma Client
npm run prisma:migrate    # Executar migrações
npm run prisma:studio     # Abrir Prisma Studio
```

### Frontend

```bash
npm run dev           # Desenvolvimento
npm run build         # Build
npm run preview       # Preview do build
npm run lint          # Linter
```

## 🐛 Troubleshooting

### Erro de conexão ao banco

- Verifique DATABASE_URL em .env
- Confirme que PostgreSQL está rodando
- Rode `npm run prisma:migrate`

### WebRTC não conecta

- Verifique se CORS está habilitado no backend
- Confirme que Socket.IO está conectado
- Adicione servidor TURN se necessário (NAT traversal)

### Porta já em uso

```bash
# Matar processo na porta
lsof -ti:3333 | xargs kill -9
lsof -ti:5173 | xargs kill -9
```

## 📚 Referências

- [WebRTC API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Socket.IO Docs](https://socket.io/docs/v4/)
- [Prisma ORM](https://www.prisma.io/docs/)
- [Vite](https://vite.dev/)
- [React 18](https://react.dev/)

## 📄 Licença

MIT

---

**Desenvolvido com ❤️ para psicólogos**
