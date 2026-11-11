# 🧠 AGENTS.md — Plataforma de Reuniões Online para Psicólogos

> Este documento orienta a IA integrada ao IDE sobre o contexto, arquitetura, regras e padrões do projeto.

---

## 📌 Visão Geral do Projeto

**Nome do produto:** Palas *(nome provisório — domínio e marca ainda não verificados)*

**Objetivo:** Plataforma web de videochamadas com áudio dedicada a psicólogos para condução de sessões terapêuticas online, com foco em privacidade, segurança e experiência clínica.

**Público-alvo:**
- Psicólogos e terapeutas como usuários primários (host da sessão)
- Pacientes como participantes (guest)

---

## 🏗️ Arquitetura Geral

```
palas/
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
- **Mutar participantes:** o psicólogo desliga o microfone de qualquer participante; só a própria pessoa religa
- **Ícone de mudo:** quem está com o microfone desligado aparece com o ícone vermelho para todos
- **Levantar a mão:** o paciente pede a palavra pelo botão "Mão"; todos veem a mão no vídeo dele. Com mais de uma mão levantada, um número discreto (1º, 2º...) mostra quem levantou primeiro. O psicólogo pode abaixar a mão de alguém
- **Indicadores visuais:** status de conexão, nível de áudio, câmera ativa
- **Sala de espera com aprovação:** o paciente informa o nome e aguarda; o psicólogo vê o pedido e admite ou recusa cada entrada
- **Vários participantes:** até `MAX_ROOM_PARTICIPANTS` pessoas por sala (padrão 6, psicólogo incluso)
- **Reconexão automática** em caso de queda de conexão
- **Chat da chamada:** botão "Chat" abre um painel (lateral no desktop, tela cheia no celular) com texto livre e envio de imagens e documentos de texto

### Módulo de Agendamento
- Psicólogo cria sessões com data, hora e duração
- Link único e seguro gerado por sessão (UUID ou token assinado)
- Paciente acessa via link sem necessidade de cadastro

### Módulo de Autenticação
- Cadastro e login exclusivo para psicólogos
- Verificação de e-mail obrigatória: login sem e-mail confirmado responde `403` com `code: "EMAIL_NOT_VERIFIED"` (conferido depois da senha); o frontend oferece reenviar o link
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
     |<-- waiting-for-approval(key)-|--- guest-waiting(nome) ----->|
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
- No primeiro pedido de entrada o paciente recebe uma `admissionKey`, que
  a sala associa ao nome dele e, após a aprovação, marca como aprovada. O
  frontend guarda nome + chave no `localStorage`, por sessão
  (`utils/guestIdentity.ts`). Voltar pelo mesmo link (reload, nova aba,
  navegador fechado, queda) não pede o nome de novo e, se já aprovado, entra
  direto. Com a chave, o servidor usa o nome do primeiro pedido (o do
  handshake é ignorado), e um novo pedido do mesmo paciente substitui o
  anterior na espera — a mesma pessoa não entra duas vezes nem com outro
  nome. A chave vale só enquanto a sala existir; outro navegador ou
  dispositivo conta como pessoa nova e passa pela aprovação.
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
- Queda involuntária do socket (celular em segundo plano, troca de rede)
  não tira o participante da sala na hora: ele mantém a vaga por
  `RECONNECT_GRACE_MS` (padrão 2 min) antes de os outros receberem
  `user-left`. Com `connectionStateRecovery`, o socket volta com o mesmo
  id e a chamada segue sem renegociar. Se voltar com outro socket (mesmo
  host, ou paciente com a mesma `admissionKey`), o novo **sempre** assume a
  vaga, mesmo que o servidor ainda não tenha notado a queda do antigo (o
  ping timeout leva ~45s). O antigo, se vivo, recebe `session-replaced` e
  é desconectado.
  Sair de propósito (`socket.disconnect()`) continua removendo na hora.
- Ao voltar a ficar visível, o cliente reconecta o socket sem esperar o
  backoff, recaptura câmera/microfone encerrados pelo sistema
  (`replaceTrack`) e faz ICE restart nas conexões caídas. Quem não criou a
  offer pede o restart com `restart-ice`.
- Limite da plataforma: navegadores mobile suspendem a **câmera** quando a
  página sai da tela (privacidade do iOS/Android). O vídeo congela para o
  outro lado e volta sozinho; só um app nativo contorna isso.
- Janela flutuante (`usePictureInPicture`): botão "Janela" mostra o vídeo
  do outro participante (o psicólogo, para o paciente) em picture-in-picture,
  com o áudio, enquanto o usuário usa outros apps. Abre sozinha ao sair da
  página onde o navegador permite (Media Session no Chrome,
  `autopictureinpicture` no Safari). Para isso o hook marca a Media Session
  como ativa (metadados + `playbackState: "playing"`) e garante o vídeo
  tocando; o navegador ainda decide se abre. O botão só aparece se houver suporte.

**Microfone (`mic-state` / `mute-participant`):**
- O servidor guarda `micMuted` de cada participante e o envia em
  `room-peers` e `user-joined`; `join-room` aceita `{ micMuted }` para quem
  entra já mutado (reconexão). Cada mudança vira `peer-mic-state` para os
  demais da sala.
- Só o host emite `mute-participant` (servidor revalida o role). O alvo
  recebe `force-muted`, desliga o próprio track de áudio e fica mudo até
  religar manualmente — não existe "desmutar outra pessoa".

**Mão levantada (`raise-hand` / `lower-hand` / `hand-state`):**
- Só pacientes levantam a mão; só o host abaixa a mão de outro (servidor
  revalida o role).
- O servidor guarda `handRaisedAt` (carimbo crescente do servidor) de cada
  participante — é ele que define a ordem, não o relógio do cliente. Vai em
  `room-peers` e `user-joined`.
- Cada mudança vira `hand-state` para **todos** da sala, inclusive quem
  levantou (recebe o próprio carimbo para saber a posição na fila).
- `join-room` aceita `{ handRaised }`: o paciente que volta com a mesma
  `admissionKey` mantém o lugar na fila.

**Chat da chamada (`chat-message`):**
- Passa pelo mesmo socket da sinalização. Só participantes **admitidos**
  enviam e recebem — paciente em espera não vê o chat.
- **Nada é gravado:** o servidor valida e repassa aos demais da sala (sem
  log do conteúdo). As mensagens vivem só na memória de cada aba; quem
  entra depois não vê o histórico, e recarregar a página o apaga.
- Texto até 2000 caracteres. Arquivos até 10 MB, enviados como binário:
  imagens (PNG, JPG, GIF, WEBP) e documentos (PDF, TXT, RTF, DOC, DOCX,
  ODT). O servidor define o tipo pela extensão e confere a assinatura do
  conteúdo (SVG/HTML nunca são aceitos). Lista em `socket/chat.ts`,
  espelhada em `frontend/src/utils/chatFiles.ts`.
- Por isso `maxHttpBufferSize` do Socket.IO é ~10 MB (padrão é 1 MB).
- Limite por socket: 10 mensagens e 30 MB de arquivos a cada 10 s.
- O remetente recebe ack `{ ok, id, sentAt }` ou `{ ok: false, error }`
  e não recebe o próprio eco.

**TURN/STUN:** o `docker-compose` sobe um `coturn` local. Sem TURN, pares
atrás de NAT simétrico não conseguem estabelecer a conexão P2P. Em
produção, usar credenciais efêmeras (`use-auth-secret`) em vez do usuário
fixo — o segredo do frontend vai para o bundle.

**Autenticação no Socket.IO (obrigatória):**
- Middleware `io.use(...)` valida o handshake antes do `connection`.
- Cliente envia `auth: { sessionId, role, accessToken?, name?, admissionKey?, hostToken? }` (guest exige `name`, 1–60 caracteres, exceto com `admissionKey` já conhecida pela sala).
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
| `POST` | `/auth/resend-verification` | Reenvia o link de confirmação de e-mail | ❌ |
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
de senha. `forgot-password` e `resend-verification` respondem igual exista
ou não a conta, para não virar um oráculo de e-mails cadastrados; o reenvio
invalida os links de verificação anteriores. Redefinir a senha incrementa
`tokenVersion`, revogando as sessões ativas.

> Envio de e-mail passa por `EmailService` (`services/email.ts`), com o
> driver escolhido por `EMAIL_DRIVER`: `console` (padrão, só registra o link
> no log), `resend` (API HTTP do Resend, exige `RESEND_API_KEY`, `EMAIL_FROM`
> e domínio próprio) ou `brevo` (API HTTP do Brevo, exige `BREVO_API_KEY` e
> `EMAIL_FROM`; aceita remetente `@gmail.com` verificado). Sempre por HTTPS:
> o plano grátis do Render bloqueia SMTP. Nos testes,
> `setEmailDriver(new InMemoryEmailDriver())`.

---

## 📋 Eventos Socket.IO

| Evento | Direção | Payload | Descrição |
|---|---|---|---|
| `join-room` | Cliente → Servidor | `{ micMuted?, handRaised? }` | Entrar na sala (host direto; guest vai para a espera) |
| `admit-guest` / `deny-guest` | Host → Servidor | `{ guestId }` | Aprovar ou recusar um paciente |
| `offer` | Cliente → Servidor | `{ to, offer }` | Enviar SDP offer a um par |
| `answer` | Cliente → Servidor | `{ to, answer }` | Enviar SDP answer a um par |
| `ice-candidate` | Cliente → Servidor | `{ to, candidate }` | Enviar ICE candidate a um par |
| `session-end` | Host → Servidor | — (ack opcional) | Encerrar a sessão para todos |
| `waiting-for-approval` | Servidor → Guest | `{ admissionKey }` | Paciente entrou na sala de espera (chave que o identifica) |
| `admitted` | Servidor → Guest | `{ admissionKey }` | Paciente aprovado |
| `admission-denied` | Servidor → Guest | `{}` | Paciente recusado |
| `guest-waiting` | Servidor → Host | `{ guestId, name }` | Novo pedido de entrada |
| `waiting-list` | Servidor → Host | `{ guests: [{ guestId, name }] }` | Lista atual de pedidos |
| `admission-error` | Servidor → Host | `{ guestId, error }` | Não foi possível admitir (sala cheia) |
| `room-peers` | Servidor → Cliente | `{ peers: [{ peerId, role, name, micMuted, handRaisedAt }] }` | Quem já está na chamada (o recém-chegado cria as offers) |
| `user-joined` | Servidor → Cliente | `{ peerId, role, name, micMuted, handRaisedAt }` | Alguém entrou na chamada |
| `user-left` | Servidor → Cliente | `{ peerId }` | Alguém saiu da chamada |
| `offer` / `answer` / `ice-candidate` | Servidor → Cliente | `{ from, ... }` | Sinalização vinda de um par |
| `room-full` | Servidor → Cliente | `{ error }` | Sala cheia ou host duplicado |
| `session-ended` | Servidor → Cliente | `{}` | Sessão encerrada pelo host |
| `restart-ice` | Cliente ↔ Servidor | `{ to }` / `{ from }` | Pede ao autor da offer um ICE restart |
| `mic-state` | Cliente → Servidor | `{ muted }` | Participante ligou/desligou o próprio microfone |
| `mute-participant` | Host → Servidor | `{ peerId }` | Desligar o microfone de um participante |
| `peer-mic-state` | Servidor → Cliente | `{ peerId, muted }` | Mudança no microfone de outro participante |
| `force-muted` | Servidor → Cliente | `{}` | O psicólogo desligou seu microfone |
| `raise-hand` | Guest → Servidor | `{ raised }` | Levantar/abaixar a própria mão |
| `lower-hand` | Host → Servidor | `{ peerId }` | Abaixar a mão de um paciente |
| `hand-state` | Servidor → Todos | `{ peerId, raisedAt \| null }` | Mão levantada (carimbo define a ordem) ou abaixada |
| `chat-message` | Cliente → Servidor | `{ text?, file?: { name, data } }` + ack | Mensagem do chat (texto e/ou arquivo binário) |
| `chat-message` | Servidor → Cliente | `{ id, from, senderName, senderRole, sentAt, text?, file?: { name, type, size, data } }` | Mensagem de outro participante |

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

# E-mail (console | resend | brevo)
EMAIL_DRIVER=console
RESEND_API_KEY=re_xxxxxxxx
BREVO_API_KEY=xkeysib-xxxxxxxx
EMAIL_FROM=Palas <nao-responda@seudominio.com.br>

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
- **Homologação:** a branch `homolog` tem frontend (URL de branch da Vercel), backend (`palas-api-homolog`) e banco próprios. Teste lá e leve à produção com PR `homolog → main`.

## 📎 Referências e Documentação

- [WebRTC API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [Socket.IO Docs](https://socket.io/docs/v4/)
- [Prisma ORM](https://www.prisma.io/docs)
- [LGPD — Lei nº 13.709/2018](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)
- [CFP — Resolução sobre Atendimento Online](https://site.cfp.org.br/resolucoes/resolucao-cfp-no-11-2018/)

---

*Atualizado em: Março/2026 — Versão 1.0*
