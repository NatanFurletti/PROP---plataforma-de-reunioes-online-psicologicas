# Deploy gratuito — Vercel + Render + Neon

| Parte | Serviço | Por quê |
|---|---|---|
| Frontend (React) | **Vercel** | Site estático com HTTPS em `*.vercel.app` |
| Backend (API + WebSocket) | **Render** (free) | Precisa de um processo contínuo com WebSocket, o que a Vercel não oferece |
| Banco (PostgreSQL) | **Neon** (free) | Postgres gerenciado, sem expiração |

```
Navegador ──► psiconnect.vercel.app ──(/api/*, rewrite)──► psiconnect-api.onrender.com ──► Neon
     └──────────── WebSocket da chamada (direto) ───────────────┘
```

- A API passa pela Vercel (`/api/*`), então para o navegador ela fica no
  mesmo domínio do site e o cookie de login continua first-party.
- O WebSocket vai direto ao Render. O psicólogo se autentica com um token
  curto pedido em `POST /api/sessions/:id/socket-token`.

---

## 1. Banco — Neon

1. Crie uma conta em https://neon.tech e um projeto na região **AWS US East (N. Virginia)**,
   a mesma do backend.
2. Em **Connection Details**, copie a connection string **direta**:
   - desmarque *Connection pooling* (o host não pode ter `-pooler`);
   - ela deve terminar com `?sslmode=require`.

   As migrations do Prisma precisam da conexão direta.

## 2. Backend — Render

1. Crie uma conta em https://render.com e conecte o GitHub.
2. **New → Blueprint** → escolha este repositório. O Render lê o [render.yaml](render.yaml).
3. Preencha as variáveis pedidas:
   - `DATABASE_URL`: a string do Neon.
   - `CLIENT_URL`: por enquanto `https://example.com`. Será trocada no passo 4.
4. Clique em **Apply**. O primeiro build leva alguns minutos e já aplica as migrations no banco.
5. Anote a URL do serviço, por exemplo `https://psiconnect-api.onrender.com`.
   Teste em `<URL>/api/health`, que deve responder `{"status":"ok"}`.

> Se a URL **não** for `psiconnect-api.onrender.com` (nome já usado), troque-a em
> [frontend/vercel.json](frontend/vercel.json) e em
> [frontend/.env.production](frontend/.env.production) e faça push.

## 3. Frontend — Vercel

1. Em https://vercel.com: **Add New → Project** → importe este repositório.
2. **Root Directory:** `frontend`. O framework (Vite) é detectado sozinho.
3. Não é preciso configurar variáveis: os valores públicos estão em `frontend/.env.production`.
4. Deploy. Anote a URL, por exemplo `https://psiconnect.vercel.app`.

## 4. Ligar as pontas

No Render, em **Environment**, troque `CLIENT_URL` pela URL da Vercel, sem barra no
final, e salve. O serviço reinicia sozinho.

O `CLIENT_URL` libera o WebSocket (CORS) e monta os links dos e-mails.

## 5. Testar

1. Abra a URL da Vercel e crie uma conta.
2. Crie uma sessão e entre nela.
3. Abra o link do paciente em outro navegador ou no celular e admita a entrada.

---

## Limitações do plano gratuito

- **Backend dorme** após ~15 min sem uso. O primeiro acesso depois disso leva
  ~1 min. Durante a chamada, a página faz um ping a cada 4 min para mantê-lo acordado.
- **Sem servidor TURN:** a chamada usa só STUN. Algumas redes (4G de algumas
  operadoras, redes corporativas) podem não conectar. Para resolver, configure um
  TURN (ex.: plano free da Metered) e preencha `VITE_TURN_*`.
- **E-mails não são enviados:** os links de verificação e de redefinição de senha
  aparecem nos **logs do Render**. Falta implementar um `EmailDriver` (SMTP/Resend).
- **Salas em memória:** um restart do backend (deploy novo, sono) derruba as
  chamadas em andamento.

## Depois do primeiro deploy

- **`TRUST_PROXY=2`** assume o caminho Vercel → Render → app. Se o rate limit de
  login bloquear usuários diferentes juntos, é sinal de que o IP real não está sendo
  lido. Nesse caso, revise esse valor.
- **Deploys automáticos:** cada push na `main` atualiza Render e Vercel.
