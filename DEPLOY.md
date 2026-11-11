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

## 4.1 E-mail — Brevo ou Resend

O login exige e-mail confirmado. Sem envio de e-mail, ninguém consegue
confirmar a conta nem redefinir a senha.

O envio usa a API HTTP do serviço. SMTP não funciona: o plano grátis do Render
bloqueia as portas 25, 465 e 587.

### Sem domínio próprio — Brevo

O Brevo aceita como remetente um endereço comum (ex.: `@gmail.com`),
confirmado por um link. O plano grátis envia até 300 e-mails por dia.

1. Crie uma conta em https://www.brevo.com.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: informe o
   nome (Palas) e o e-mail (ex.: `psipalascall@gmail.com`) e clique no link de
   confirmação que chega nessa caixa.
3. **SMTP & API → API Keys → Generate a new API key**.
4. No Render, em **Environment**:
   - `EMAIL_DRIVER=brevo`
   - `BREVO_API_KEY=` a chave do passo 3
   - `EMAIL_FROM=Palas <psipalascall@gmail.com>` (o remetente do passo 2)

Remetente `@gmail.com` saindo pelo Brevo tem mais chance de cair no spam. Com
domínio próprio, prefira o Resend.

### Com domínio próprio — Resend

1. Crie uma conta em https://resend.com.
2. **Domains → Add Domain**: cadastre o domínio do remetente e crie no DNS os
   registros que o Resend mostrar (SPF/DKIM). Espere o status ficar **Verified**.
3. **API Keys → Create API Key** com permissão *Sending access*.
4. No Render, em **Environment**:
   - `EMAIL_DRIVER=resend`
   - `RESEND_API_KEY=` a chave do passo 3
   - `EMAIL_FROM=Palas <nao-responda@seudominio.com.br>` (do domínio verificado)

Com `EMAIL_DRIVER=resend` ou `brevo` e a chave ou o remetente faltando, o backend nem
sobe; o erro aparece no log do deploy. Sem domínio próprio, o Resend só deixa
enviar para o e-mail da sua conta (bom para testar a homologação).

**Contas criadas antes desta exigência** nunca receberam o link. Elas podem
usar **Reenviar link** na tela de login. Para liberar todas de uma vez, rode no
SQL Editor do Neon:

```sql
UPDATE "Psychologist" SET "emailVerifiedAt" = NOW() WHERE "emailVerifiedAt" IS NULL;
```

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
  TURN (ex.: plano free da Metered) e preencha `VITE_TURN_*`. `VITE_TURN_URL`
  aceita várias URLs separadas por vírgula; inclua as de TCP/TLS na porta 443.
- **E-mail:** sem `EMAIL_DRIVER=brevo` ou `resend` (passo 4.1), os links de verificação e de
  redefinição aparecem só nos **logs do Render** e ninguém consegue confirmar a conta.
- **Salas em memória:** um restart do backend (deploy novo, sono) derruba as
  chamadas em andamento.

## Depois do primeiro deploy

- **`TRUST_PROXY=2`** assume o caminho Vercel → Render → app. Se o rate limit de
  login bloquear usuários diferentes juntos, é sinal de que o IP real não está sendo
  lido. Nesse caso, revise esse valor.
- **Deploys automáticos:** cada push na `main` atualiza Render e Vercel.

---

## Homologação (ambiente de testes)

| Branch | Ambiente | Frontend | Backend | Banco |
|---|---|---|---|---|
| `main` | Produção | URL de produção da Vercel | `psiconnect-api` | Neon, database de produção |
| `homolog` | Homologação | `prop-plataforma-de-reunioes-git-84ac90-natanfurlettis-projects.vercel.app` | `palas-api-homolog` | Neon, projeto `palas-homolog` |

**Fluxo:** suba as mudanças na `homolog`, teste lá e, se estiver tudo certo,
abra um PR `homolog → main` para levar a mudança à produção.

Como funciona: na branch `homolog` a Vercel faz o build com
`--mode homolog` (lê [frontend/.env.homolog](frontend/.env.homolog)), e o
[frontend/vercel.json](frontend/vercel.json) repassa `/api` para o backend de
homologação quando o host é a URL da branch. Os mesmos arquivos vão para a
`main` sem afetar a produção.

### Configuração (uma vez só)

1. **Neon — banco separado.** Crie um **projeto novo** (`palas-homolog`,
   região AWS US East / N. Virginia) e copie a connection string **direta**
   dele (sem `-pooler`, com `?sslmode=require`). Projeto separado, e não uma
   database ou *branch* no projeto de produção: no Neon, usuários criados pelo
   painel leem todas as databases do projeto, e uma branch copia os dados
   reais de psicólogos (LGPD).
2. **Render — backend de homologação.** **New → Web Service** → este repositório:
   - **Name:** `palas-api-homolog` · **Branch:** `homolog` · **Region:** Virginia
   - **Runtime:** Docker · **Dockerfile Path:** `./backend/Dockerfile` ·
     **Docker Context:** `./backend` · **Health Check Path:** `/api/health`
   - **Plan:** Free
   - **Environment:** `NODE_ENV=production`, `DATABASE_URL` (do passo 1),
     `JWT_SECRET` (um valor novo, diferente da produção), `JWT_EXPIRES_IN=8h`,
     `TRUST_PROXY=2`, `MAX_ROOM_PARTICIPANTS=6`, `CLIENT_URL` (passo 4) e as
     variáveis de e-mail do passo 4.1 (`EMAIL_DRIVER`, `BREVO_API_KEY` ou `RESEND_API_KEY`, `EMAIL_FROM`).

   > Se a URL não sair `palas-api-homolog.onrender.com`, troque-a em
   > [frontend/.env.homolog](frontend/.env.homolog) e no primeiro rewrite de
   > [frontend/vercel.json](frontend/vercel.json).
3. **Vercel — URL da branch.** Nada a criar: todo push na `homolog` gera um
   deploy no domínio fixo da branch (em **Active Branches → homolog → Domains**).
   Como o nome do projeto é longo, a Vercel encurta esse domínio e troca o nome
   da branch por um código (`-git-84ac90-`), que não muda entre deploys. Esse
   domínio está no primeiro rewrite de [frontend/vercel.json](frontend/vercel.json);
   se o projeto for renomeado, atualize-o lá. Use sempre esse domínio: as URLs
   com hash de commit falam com o backend de produção.
   - Em **Settings → Deployment Protection**, desative a *Vercel Authentication*
     (ou deixe só para produção). Senão o paciente de teste precisa de login na Vercel.
4. **Ligar as pontas.** No Render (`palas-api-homolog`), coloque em `CLIENT_URL`
   o domínio do passo 3, sem barra no final.
