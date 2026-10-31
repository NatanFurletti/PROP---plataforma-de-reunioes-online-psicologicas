# 🧠 AGENTS.md — Plataforma de Reuniões Online para Psicólogos

> Este documento orienta a IA integrada ao IDE sobre o contexto, arquitetura, regras e padrões do projeto.

---

## 📌 Visão Geral do Projeto

**Nome do produto:** PsiConnect *(sugestão — ajuste conforme necessário)*

**Objetivo:** Plataforma web de videochamadas com áudio dedicada a psicólogos para condução de sessões terapêuticas online, com foco em privacidade, segurança e experiência clínica.

**Público-alvo:**
- Psicólogos e terapeutas como usuários primários (host da sessão)
- Pacientes como participantes (guest)

---

## 🏗️ Arquitetura Geral

```
psiconnect/
├── frontend/           # Interface do usuário (React + TypeScript)
│   ├── src/
│   │   ├── components/     # Componentes reutilizáveis
│   │   ├── pages/          # Páginas da aplicação
│   │   ├── hooks/          # Custom hooks (ex: useWebRTC, useMedia)
│   │   ├── contexts/       # Contextos globais (Auth, Session, Media)
│   │   ├── services/       # Chamadas de API e WebSocket
│   │   └── utils/          # Funções auxiliares
├── backend/            # API REST + Servidor de Sinalização WebRTC
│   ├── src/
│   │   ├── controllers/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── models/
│   │   └── socket/         # Lógica de WebSocket / WebRTC signaling
├── infra/              # Configurações de infraestrutura (Docker, CI/CD)
└── AGENTS.md           # Este arquivo
```

---

## 🛠️ Stack Tecnológico

### Frontend
| Camada | Tecnologia |
|---|---|
| Framework | React 18+ com TypeScript |
| Estilização | Tailwind CSS |
| Gerenciamento de estado | Zustand |
| Roteamento | React Router v6 |
| Videochamada | WebRTC (nativo) |
| WebSocket (cliente) | Socket.IO Client |
| Autenticação | JWT via HTTP-only cookies (com tokenVersion para revogação) |
| Testes | Vitest + Testing Library |

### Backend
| Camada | Tecnologia |
|---|---|
| Runtime | Node.js + TypeScript |
| Framework | Express.js |
| WebSocket / Signaling | Socket.IO |
| Banco de dados | PostgreSQL + Prisma ORM |
| Autenticação | JWT + bcrypt + tokenVersion |
| Variáveis de ambiente | dotenv (validadas em `config/env.ts`) |
| Logs | pino + pino-http (com redact de campos sensíveis) |
| Segurança HTTP | helmet + express-rate-limit |
| Testes | Vitest |

### Infraestrutura
| Componente | Tecnologia |
|---|---|
| Containerização | Docker + Docker Compose |
| Servidor TURN/STUN | Coturn (self-hosted) ou serviço gerenciado |
| Storage de mídia (opcional) | AWS S3 ou equivalente |
| CI/CD | GitHub Actions |

---

## 🎥 Funcionalidades Principais

### Módulo de Videochamada
- **Vídeo e áudio bidirecional** via WebRTC peer-to-peer
- **Controles de sessão:** mutar microfone, ativar/desativar câmera, encerrar chamada
- **Indicadores visuais:** status de conexão, nível de áudio, câmera ativa
- **Sala de espera com aprovação:** o paciente informa o nome e aguarda; o psicólogo vê o pedido e admite ou recusa cada entrada
- **Vários participantes:** até `MAX_ROOM_PARTICIPANTS` pessoas por sala (padrão 6, psicólogo incluso)
- **Reconexão automática** em caso de queda de conexão

### Módulo de Agendamento
- Psicólogo cria sessões com data, hora e duração
- Link único e seguro gerado por sessão (UUID ou token assinado)
- Paciente acessa via link sem necessidade de cadastro

### Módulo de Autenticação
- Cadastro e login exclusivo para psicólogos
- Verificação de e-mail obrigatória
- Recuperação de senha via e-mail

### Módulo de Gestão do Psicólogo (Dashboard)
- Listagem de sessões agendadas, em andamento e encerradas
- Histórico de sessões
- Configurações de perfil e preferências

---

## 🔐 Requisitos de Segurança e Privacidade

> Contexto clínico exige atenção máxima à privacidade dos dados.

- **NUNCA** armazene o conteúdo de vídeo/áudio das sessões sem consentimento explícito e documentado
- Todas as comunicações devem trafegar via **HTTPS/WSS** (TLS obrigatório)
- Tokens JWT devem ser armazenados em **HTTP-only cookies**, jamais em `localStorage`
- Sessões devem expirar automaticamente após inatividade
- Links de sessão devem ser de **uso único ou com expiração** configurável
- Validar e sanitizar **todos** os inputs no backend
- Logs de acesso não devem conter dados sensíveis de pacientes
- Seguir princípios da **LGPD** (Lei Geral de Proteção de Dados — Brasil)

---

## 🔄 Fluxo WebRTC — Sinalização

Cada sala tem **um psicólogo (host)** e um ou mais pacientes (guests). A
chamada é uma **malha P2P**: cada participante tem uma `RTCPeerConnection`
com cada um dos outros. A sinalização usa **Offer/Answer** via Socket.IO,
sempre endereçada a um par (`to`) e entregue com o remetente (`from`).

```
Paciente (novo)            Servidor (Signaling)         Psicólogo (Host)
     |--- join-room --------------->|                              |
     |<-- waiting-for-approval -----|--- guest-waiting(nome) ----->|
     |                              |<-- admit-guest(guestId) -----|
     |<-- admitted(admissionKey) ---|                              |
     |<-- room-peers([pares]) ------|--- user-joined(peer) ------->|
     |--- offer(to: cada par) ----->|--- offer(from) ------------->|
     |<-- answer(from) -------------|<-- answer(to) ---------------|
     |<======= ICE candidates (to/from) =========================>|
     |<========== Conexão P2P com cada participante ============>|
```

**Regras para o código de sinalização:**
- Quem acaba de entrar na chamada recebe `room-peers` e **cria a offer para
  cada par**; os demais só recebem `user-joined` e respondem à offer.
- `offer`/`answer`/`ice-candidate` só circulam entre participantes
  **admitidos** da mesma sala — paciente em espera não sinaliza.
- Somente o host admite/recusa pacientes e encerra a sessão (servidor revalida o role).
- Um único host por sala. Limite total: `MAX_ROOM_PARTICIPANTS` (padrão 6).
  A malha P2P não escala bem além disso — acima disso, usar um SFU.
- Ao ser admitido, o paciente recebe uma `admissionKey` (guardada no
  `sessionStorage`); com ela, reload ou queda de rede voltam direto à
  chamada, sem nova aprovação. A chave vale só enquanto a sala existir.
- `session-ended` vai para todos (inclusive quem aguardava). O cliente que
  encerra/sai navega por conta própria — não espera resposta do servidor.

**Salas e ciclo de vida:**
- O estado das salas vive em um `Map` em memória do processo. Isso limita o
  backend a **uma única instância** — para escalar horizontalmente é preciso
  o `@socket.io/redis-adapter` e mover esse estado para o Redis.
- Sala sem participantes por 5 minutos é encerrada por um varredor
  periódico, que marca a sessão como `COMPLETED`. A janela existe para
  tolerar reconexão; sem ela, uma queda dos dois lados deixaria a sessão
  presa em `IN_PROGRESS`.

**TURN/STUN:** o `docker-compose` sobe um `coturn` local. Sem TURN, pares
atrás de NAT simétrico não conseguem estabelecer a conexão P2P. Em
produção, usar credenciais efêmeras (`use-auth-secret`) em vez do usuário
fixo — o segredo do frontend vai para o bundle.

**Autenticação no Socket.IO (obrigatória):**
- Middleware `io.use(...)` valida o handshake antes do `connection`.
- Cliente envia `auth: { sessionId, role, accessToken?, name?, admissionKey?, hostToken? }` (guest exige `name`, 1–60 caracteres).
- Host autentica com `hostToken`: JWT curto (5 min, `purpose: "host-socket"`, preso a uma sessão e à `tokenVersion`) emitido por `POST /sessions/:id/socket-token`. Em produção o frontend (Vercel) e o backend (Render) estão em domínios diferentes e o cookie de login não chega ao socket. Sem `hostToken`, o servidor aceita o cookie JWT (mesmo domínio, desenvolvimento). Em ambos os casos o psicólogo deve ser o dono da `Session`.
- O `hostToken` não vale como login e o JWT de login não vale como `hostToken` (`verifyToken` rejeita tokens com `purpose`).
- Guest autentica via `accessToken` (igual ao da `Session`).
- Os handlers de socket (`offer`/`answer`/etc.) **leem `sessionId` e `role` de `socket.data.auth`**, nunca do payload do cliente — isso impede que um socket emita para sala que não autenticou.
- Apenas o host pode emitir `session-end` (servidor revalida o role).

---

## 🧩 Padrões de Código

### Geral
- Usar **TypeScript** estritamente — sem `any` exceto quando absolutamente inevitável
- Preferir **funções puras** e componentes funcionais
- Nomear variáveis e funções em **inglês**
- Comentários explicativos em **português** quando a lógica for complexa

### Frontend — Componentes React
```tsx
// ✅ Correto: componente funcional com tipagem explícita
interface VideoTileProps {
  stream: MediaStream | null;
  label: string;
  isMuted?: boolean;
}

export const VideoTile = ({ stream, label, isMuted = false }: VideoTileProps) => {
  // ...
};
```

### Custom Hook — useWebRTC
```ts
// Encapsular toda lógica de WebRTC neste hook
// Retornar: localStream, remoteStream, toggleMic, toggleCamera, endCall, connectionState
export const useWebRTC = (sessionId: string) => { ... };
```

### Backend — Controllers
```ts
// Controllers devem apenas orquestrar — lógica de negócio fica nos Services
export const createSession = async (req: Request, res: Response) => {
  try {
    const session = await SessionService.create(req.body, req.user.id);
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
};
```

### Tratamento de erros
- Backend: usar middleware global de erros com `next(error)`
- Frontend: erros de WebRTC devem ser capturados e exibidos ao usuário com mensagem amigável
- Nunca expor stack traces ou detalhes internos ao cliente em produção

---

## 🗄️ Modelos de Dados (Prisma)

```prisma
model Psychologist {
  id            String    @id @default(uuid())
  name          String
  email         String    @unique
  passwordHash  String
  crp           String?   // Registro no Conselho Regional de Psicologia
  tokenVersion  Int       @default(0) // incrementada no logout para revogar JWTs
  emailVerifiedAt DateTime?           // null enquanto o e-mail não for confirmado
  createdAt     DateTime  @default(now())
  sessions      Session[]
  tokens        VerificationToken[]
}

model VerificationToken {
  id             String    @id @default(uuid())
  psychologistId String
  tokenHash      String    @unique  // SHA-256; o token em claro nunca é persistido
  type           TokenType
  expiresAt      DateTime
  usedAt         DateTime?           // uso único
  createdAt      DateTime  @default(now())
}

enum TokenType {
  EMAIL_VERIFICATION
  PASSWORD_RESET
}

model Session {
  id              String    @id @default(uuid())
  psychologistId  String
  psychologist    Psychologist @relation(fields: [psychologistId], references: [id])
  scheduledAt     DateTime
  durationMinutes Int       @default(50)
  status          SessionStatus @default(SCHEDULED)
  accessToken     String    @unique  // token do paciente para entrar
  createdAt       DateTime  @default(now())
}

enum SessionStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
}
```

---

## 🚦 Endpoints da API

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Cadastro de psicólogo | ❌ |
| `POST` | `/auth/login` | Login | ❌ |
| `GET`  | `/auth/me` | Retorna o psicólogo autenticado | ✅ |
| `POST` | `/auth/logout` | Logout (incrementa tokenVersion) | ✅ |
| `GET` | `/auth/verify-email/:token` | Confirma e-mail via link | ❌ |
| `POST` | `/auth/forgot-password` | Solicita link de redefinição | ❌ |
| `POST` | `/auth/reset-password` | Redefine a senha com o token | ❌ |
| `GET` | `/sessions` | Listar sessões do psicólogo | ✅ |
| `POST` | `/sessions` | Criar nova sessão | ✅ |
| `GET` | `/sessions/:id` | Detalhes de uma sessão | ✅ |
| `PATCH` | `/sessions/:id/status` | Atualizar status (inclui cancelar) | ✅ |
| `PATCH` | `/sessions/:id/reschedule` | Reagendar sessão | ✅ |
| `GET` | `/sessions/join/:token` | Validar token do paciente | ❌ |
| `POST` | `/sessions/:id/socket-token` | Token curto para o host conectar o WebSocket | ✅ |

**Tokens de e-mail (`VerificationToken`):** apenas o hash SHA-256 é
persistido — o valor em claro só existe no link enviado. Uso único
(`usedAt`), com expiração de 24h para verificação e 1h para redefinição
de senha. `forgot-password` responde igual exista ou não a conta, para não
virar um oráculo de e-mails cadastrados. Redefinir a senha incrementa
`tokenVersion`, revogando as sessões ativas.

> Envio de e-mail passa por `EmailService` (`services/email.ts`). Em
> desenvolvimento o driver padrão apenas registra o link no log; para
> produção, implementar `EmailDriver` com SMTP/Resend/SES e injetar via
> `setEmailDriver`.

---

## 📋 Eventos Socket.IO

| Evento | Direção | Payload | Descrição |
|---|---|---|---|
| `join-room` | Cliente → Servidor | — | Entrar na sala (host direto; guest vai para a espera) |
| `admit-guest` / `deny-guest` | Host → Servidor | `{ guestId }` | Aprovar ou recusar um paciente |
| `offer` | Cliente → Servidor | `{ to, offer }` | Enviar SDP offer a um par |
| `answer` | Cliente → Servidor | `{ to, answer }` | Enviar SDP answer a um par |
| `ice-candidate` | Cliente → Servidor | `{ to, candidate }` | Enviar ICE candidate a um par |
| `session-end` | Host → Servidor | — (ack opcional) | Encerrar a sessão para todos |
| `waiting-for-approval` | Servidor → Guest | `{}` | Paciente entrou na sala de espera |
| `admitted` | Servidor → Guest | `{ admissionKey }` | Paciente aprovado |
| `admission-denied` | Servidor → Guest | `{}` | Paciente recusado |
| `guest-waiting` | Servidor → Host | `{ guestId, name }` | Novo pedido de entrada |
| `waiting-list` | Servidor → Host | `{ guests: [{ guestId, name }] }` | Lista atual de pedidos |
| `admission-error` | Servidor → Host | `{ guestId, error }` | Não foi possível admitir (sala cheia) |
| `room-peers` | Servidor → Cliente | `{ peers: [{ peerId, role, name }] }` | Quem já está na chamada (o recém-chegado cria as offers) |
| `user-joined` | Servidor → Cliente | `{ peerId, role, name }` | Alguém entrou na chamada |
| `user-left` | Servidor → Cliente | `{ peerId }` | Alguém saiu da chamada |
| `offer` / `answer` / `ice-candidate` | Servidor → Cliente | `{ from, ... }` | Sinalização vinda de um par |
| `room-full` | Servidor → Cliente | `{ error }` | Sala cheia ou host duplicado |
| `session-ended` | Servidor → Cliente | `{}` | Sessão encerrada pelo host |

---

## ✅ Regras para a IA (Diretrizes Operacionais)

### O que FAZER
- ✅ Sempre tipar explicitamente com TypeScript
- ✅ Encapsular lógica WebRTC no hook `useWebRTC`
- ✅ Validar todos os inputs no backend com uma biblioteca como `zod`
- ✅ Usar variáveis de ambiente para credenciais (nunca hardcodar)
- ✅ Implementar tratamento de erro em todas as operações assíncronas
- ✅ Fechar streams de mídia (`stream.getTracks().forEach(t => t.stop())`) ao encerrar chamadas
- ✅ Garantir que nenhum paciente entre na chamada sem aprovação do psicólogo
- ✅ Considerar acessibilidade (ARIA labels, foco no teclado) nos componentes de UI

### O que NÃO FAZER
- ❌ Não gravar vídeo/áudio sem lógica explícita de consentimento implementada
- ❌ Não armazenar JWT em `localStorage` ou `sessionStorage`
- ❌ Não permitir mais de `MAX_ROOM_PARTICIPANTS` pessoas nem mais de um host na mesma sala
- ❌ Não expor o ID interno do paciente ou do psicólogo em URLs públicas
- ❌ Não usar `console.log` com dados sensíveis em produção
- ❌ Não criar lógica de negócio diretamente em Controllers ou Componentes React
- ❌ Não ignorar erros de WebRTC — sempre logar e notificar o usuário

---

## 🌍 Variáveis de Ambiente

```env
# Backend
DATABASE_URL=postgresql://user:password@localhost:5432/psiconnect
JWT_SECRET=sua_chave_secreta_aqui
JWT_EXPIRES_IN=8h
PORT=3333
CLIENT_URL=http://localhost:5173
MAX_ROOM_PARTICIPANTS=6   # psicólogo incluso

# WebRTC / TURN
TURN_URL=turn:seu-servidor-turn:3478
TURN_USERNAME=usuario
TURN_CREDENTIAL=senha

# Produção atrás de proxy (Vercel rewrite → Render → app)
TRUST_PROXY=2

# Frontend (.env)
VITE_API_URL=http://localhost:3333
VITE_SOCKET_URL=http://localhost:3333
```

---

## 🚀 Deploy

Frontend na **Vercel**, backend no **Render**, banco no **Neon** — passo a passo em [DEPLOY.md](DEPLOY.md).
- A Vercel repassa `/api/*` ao backend (`frontend/vercel.json`): API no mesmo domínio do site, cookie first-party.
- O WebSocket vai direto ao Render (`VITE_SOCKET_URL` em `frontend/.env.production`).
- O backend roda como **uma única instância** (salas em memória).

## 📎 Referências e Documentação

- [WebRTC API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Socket.IO Docs](https://socket.io/docs/v4/)
- [Prisma ORM](https://www.prisma.io/docs)
- [LGPD — Lei nº 13.709/2018](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- [CFP — Resolução sobre Atendimento Online](https://site.cfp.org.br/resolucoes/resolucao-cfp-no-11-2018/)

---

*Atualizado em: Março/2026 — Versão 1.0*
