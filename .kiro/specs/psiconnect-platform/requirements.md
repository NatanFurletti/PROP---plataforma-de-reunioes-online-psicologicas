# Requirements Document

## Introduction

O PsiConnect é uma plataforma web de videochamadas dedicada a psicólogos para condução de sessões terapêuticas online. A plataforma conecta psicólogos (hosts) a pacientes (guests) via WebRTC peer-to-peer, com sinalização via Socket.IO, autenticação segura por JWT em HTTP-only cookies e conformidade com a LGPD. Este documento cobre a implementação completa dos módulos de autenticação, agendamento, videochamada, sala de espera e dashboard do psicólogo, partindo de uma estrutura base já existente.

---

## Glossary

- **System**: O PsiConnect como sistema completo
- **Backend**: Servidor Node.js/Express responsável pela API REST e sinalização WebRTC
- **Frontend**: Aplicação React responsável pela interface do usuário
- **Auth_Service**: Serviço de autenticação do backend (registro, login, logout)
- **Session_Service**: Serviço de gerenciamento de sessões terapêuticas
- **Signaling_Server**: Componente Socket.IO do backend responsável pela troca de mensagens WebRTC
- **WebRTC_Hook**: Hook `useWebRTC` do frontend que encapsula toda a lógica de conexão peer-to-peer
- **Dashboard**: Página do psicólogo para gerenciar sessões agendadas, em andamento e encerradas
- **Waiting_Room**: Tela exibida ao paciente enquanto aguarda o psicólogo iniciar a sessão
- **Psychologist**: Usuário cadastrado na plataforma com papel de host da sessão
- **Patient**: Participante que acessa a sessão via token único, sem necessidade de cadastro
- **Session**: Sessão terapêutica com data, hora, duração e token de acesso único
- **Access_Token**: Token único e com expiração gerado por sessão para acesso do paciente
- **ICE_Candidate**: Candidato de conectividade trocado durante o estabelecimento WebRTC
- **SDP**: Session Description Protocol — descreve as capacidades de mídia de cada peer

---

## Requirements

### Requirement 1: Registro de Psicólogo

**User Story:** Como psicólogo, quero me cadastrar na plataforma com meu e-mail e senha, para que eu possa acessar o sistema e gerenciar minhas sessões.

#### Acceptance Criteria

1. WHEN um psicólogo submete o formulário de registro com nome, e-mail, senha e CRP, THE Auth_Service SHALL criar uma conta com a senha armazenada como hash bcrypt e retornar status 201.
2. WHEN um e-mail já cadastrado é utilizado no registro, THE Auth_Service SHALL retornar status 409 com mensagem de erro descritiva.
3. WHEN campos obrigatórios (nome, e-mail, senha) estão ausentes ou inválidos, THE Backend SHALL retornar status 400 com os campos inválidos identificados.
4. THE Backend SHALL validar o formato do e-mail e exigir senha com no mínimo 8 caracteres.
5. WHEN o registro é bem-sucedido, THE Frontend SHALL redirecionar o psicólogo para a página de login.

---

### Requirement 2: Autenticação do Psicólogo

**User Story:** Como psicólogo, quero fazer login com meu e-mail e senha, para que eu possa acessar o dashboard e conduzir sessões.

#### Acceptance Criteria

1. WHEN um psicólogo submete credenciais válidas, THE Auth_Service SHALL retornar um JWT assinado armazenado em HTTP-only cookie com expiração de 8 horas.
2. WHEN credenciais inválidas são submetidas, THE Auth_Service SHALL retornar status 401 sem revelar qual campo está incorreto.
3. WHEN o psicólogo realiza logout, THE Auth_Service SHALL invalidar o cookie JWT e retornar status 200.
4. WHILE o cookie JWT está ausente ou expirado, THE Backend SHALL retornar status 401 para rotas protegidas.
5. THE Backend SHALL armazenar o JWT exclusivamente em HTTP-only cookie — nunca em `localStorage` ou `sessionStorage`.
6. WHEN o psicólogo acessa uma rota protegida com token válido, THE Backend SHALL processar a requisição sem solicitar nova autenticação.

---

### Requirement 3: Registro de Rotas e Middleware no Servidor

**User Story:** Como desenvolvedor, quero que o servidor Express registre todas as rotas e middlewares necessários, para que a API funcione corretamente.

#### Acceptance Criteria

1. THE Backend SHALL registrar o middleware `cookie-parser` antes de qualquer rota para leitura de cookies HTTP-only.
2. THE Backend SHALL registrar o middleware de autenticação JWT nas rotas protegidas antes de invocar os controllers.
3. THE Backend SHALL registrar as rotas de autenticação (`/auth/register`, `/auth/login`, `/auth/logout`) no servidor Express.
4. THE Backend SHALL registrar as rotas de sessão (`/sessions`, `/sessions/:id`, `/sessions/:id/status`, `/sessions/join/:token`) no servidor Express.
5. THE Backend SHALL aplicar middleware global de tratamento de erros como último middleware registrado.
6. IF uma rota inexistente é acessada, THEN THE Backend SHALL retornar status 404 com mensagem padronizada.

---

### Requirement 4: Gerenciamento de Sessões pelo Psicólogo

**User Story:** Como psicólogo, quero criar e visualizar minhas sessões agendadas, para que eu possa organizar minha agenda e compartilhar o link de acesso com os pacientes.

#### Acceptance Criteria

1. WHEN um psicólogo autenticado cria uma sessão com data, hora e duração, THE Session_Service SHALL persistir a sessão no banco de dados e gerar um `accessToken` UUID único.
2. THE Session_Service SHALL definir expiração do `accessToken` com base na data e hora agendada mais a duração da sessão, acrescida de 30 minutos de tolerância.
3. WHEN o psicólogo solicita a listagem de sessões, THE Session_Service SHALL retornar apenas as sessões pertencentes ao psicólogo autenticado, ordenadas por `scheduledAt` decrescente.
4. THE Dashboard SHALL exibir para cada sessão: data, hora, duração, status e o link de acesso do paciente.
5. WHEN o psicólogo clica em "Copiar link", THE Frontend SHALL copiar para a área de transferência a URL completa de acesso do paciente no formato `{CLIENT_URL}/join/{accessToken}`.
6. IF a data ou hora da sessão é inválida (ex: data no passado), THEN THE Backend SHALL retornar status 400 com mensagem descritiva.

---

### Requirement 5: Acesso do Paciente via Token

**User Story:** Como paciente, quero acessar a sessão pelo link recebido sem precisar me cadastrar, para que eu possa participar da consulta de forma simples e segura.

#### Acceptance Criteria

1. WHEN um paciente acessa `/join/:token`, THE Frontend SHALL exibir a página de entrada solicitando apenas o nome do paciente.
2. WHEN o paciente submete o nome, THE Backend SHALL validar o `accessToken` e retornar os dados da sessão (data, hora, nome do psicólogo) com status 200.
3. IF o `accessToken` é inválido ou inexistente, THEN THE Backend SHALL retornar status 404.
4. IF o `accessToken` está expirado, THEN THE Backend SHALL retornar status 410 com mensagem indicando que a sessão não está mais disponível.
5. THE Backend SHALL rejeitar tokens de sessões com status `CANCELLED` ou `COMPLETED` retornando status 410.
6. THE Frontend SHALL armazenar o nome do paciente e o token em memória de sessão (não em `localStorage`) para uso durante a videochamada.

---

### Requirement 6: Sala de Espera do Paciente

**User Story:** Como paciente, quero aguardar em uma sala de espera até o psicólogo iniciar a sessão, para que eu não entre na chamada antes do momento adequado.

#### Acceptance Criteria

1. WHEN o paciente entra na sala antes do psicólogo, THE Waiting_Room SHALL exibir mensagem informando que o psicólogo ainda não iniciou a sessão.
2. WHEN o psicólogo entra na sala, THE Signaling_Server SHALL emitir o evento `user-joined` para o paciente em espera.
3. WHEN o evento `user-joined` é recebido pelo paciente, THE Frontend SHALL transicionar automaticamente da Waiting_Room para a tela de videochamada.
4. WHILE o paciente está na Waiting_Room, THE Frontend SHALL manter a conexão Socket.IO ativa para receber o evento de início.
5. IF a conexão Socket.IO cair durante a espera, THE Frontend SHALL tentar reconectar automaticamente por até 3 tentativas com intervalo de 3 segundos entre cada uma.

---

### Requirement 7: Sinalização WebRTC com Limite de Participantes

**User Story:** Como desenvolvedor, quero que o servidor de sinalização gerencie corretamente o fluxo WebRTC entre exatamente 2 participantes, para que a conexão peer-to-peer seja estabelecida com segurança.

#### Acceptance Criteria

1. THE Signaling_Server SHALL limitar cada sala a exatamente 2 participantes (psicólogo + paciente) — conexões adicionais devem ser rejeitadas com evento de erro.
2. WHEN um participante emite `join-room` com `sessionId` e `role` válidos, THE Signaling_Server SHALL adicionar o socket à sala e notificar o outro participante com `user-joined`.
3. WHEN o psicólogo emite `offer` com SDP, THE Signaling_Server SHALL encaminhar o offer para o paciente na mesma sala.
4. WHEN o paciente emite `answer` com SDP, THE Signaling_Server SHALL encaminhar o answer para o psicólogo na mesma sala.
5. WHEN qualquer participante emite `ice-candidate`, THE Signaling_Server SHALL encaminhar o candidato para o outro participante da sala.
6. WHEN um participante desconecta, THE Signaling_Server SHALL emitir `user-left` para o participante restante e remover a sala se ambos saírem.
7. WHEN o psicólogo emite `session-end`, THE Signaling_Server SHALL emitir `session-ended` para todos na sala e atualizar o status da sessão para `COMPLETED` no banco de dados.

---

### Requirement 8: Integração WebRTC no Frontend

**User Story:** Como psicólogo ou paciente, quero que a videochamada seja estabelecida automaticamente ao entrar na sala, para que eu possa conduzir ou participar da sessão sem configurações manuais.

#### Acceptance Criteria

1. WHEN o WebRTC_Hook é inicializado, THE Frontend SHALL solicitar permissão de câmera e microfone ao usuário antes de qualquer outra ação.
2. IF o usuário nega permissão de câmera ou microfone, THEN THE Frontend SHALL exibir mensagem de erro amigável e impedir o ingresso na chamada.
3. WHEN o evento `user-joined` é recebido, THE WebRTC_Hook SHALL iniciar o processo de offer/answer conforme o papel do participante (psicólogo cria offer, paciente responde com answer).
4. WHEN a conexão peer-to-peer é estabelecida, THE WebRTC_Hook SHALL expor `localStream` e `remoteStream` para renderização nos componentes de vídeo.
5. THE WebRTC_Hook SHALL encapsular os métodos `toggleMic`, `toggleCamera` e `endCall`, retornando o estado atual de cada controle.
6. WHEN `endCall` é invocado, THE WebRTC_Hook SHALL fechar todos os tracks de mídia via `stream.getTracks().forEach(t => t.stop())` e encerrar a conexão peer.
7. IF a conexão WebRTC cair durante a sessão, THEN THE WebRTC_Hook SHALL tentar reconectar automaticamente por até 3 tentativas antes de notificar o usuário.
8. THE WebRTC_Hook SHALL usar as configurações de STUN/TURN definidas nas variáveis de ambiente para estabelecer a conexão.

---

### Requirement 9: Interface da Videochamada

**User Story:** Como psicólogo ou paciente, quero visualizar o vídeo do outro participante e controlar meu áudio e câmera durante a sessão, para que eu possa conduzir a consulta de forma eficaz.

#### Acceptance Criteria

1. THE Frontend SHALL exibir o vídeo remoto em destaque (layout principal) e o vídeo local em miniatura (picture-in-picture).
2. THE Frontend SHALL exibir indicadores visuais de estado: microfone mutado, câmera desativada e status da conexão WebRTC.
3. WHEN o psicólogo clica em "Encerrar sessão", THE Frontend SHALL exibir diálogo de confirmação antes de encerrar a chamada.
4. WHEN a sessão é encerrada pelo psicólogo, THE Frontend SHALL redirecionar o psicólogo para o Dashboard e o paciente para uma tela de encerramento.
5. THE Frontend SHALL exibir o nome do participante remoto abaixo do vídeo correspondente.
6. WHILE a conexão WebRTC está sendo estabelecida, THE Frontend SHALL exibir indicador de carregamento no lugar do vídeo remoto.

---

### Requirement 10: Segurança e Conformidade com LGPD

**User Story:** Como psicólogo, quero que a plataforma proteja os dados dos meus pacientes e esteja em conformidade com a LGPD, para que eu possa conduzir sessões com segurança jurídica e ética.

#### Acceptance Criteria

1. THE System SHALL transmitir todas as comunicações exclusivamente via HTTPS e WSS (TLS obrigatório em produção).
2. THE Backend SHALL validar e sanitizar todos os inputs recebidos usando a biblioteca `zod` antes de processar qualquer requisição.
3. THE System SHALL não gravar ou armazenar conteúdo de vídeo ou áudio das sessões — o tráfego de mídia é exclusivamente peer-to-peer.
4. THE Backend SHALL garantir que logs de acesso não contenham dados sensíveis de pacientes (nome, conteúdo de sessão).
5. WHEN uma sessão expira por inatividade superior a 30 minutos, THE Backend SHALL invalidar o JWT do psicólogo e encerrar a sessão Socket.IO correspondente.
6. THE Backend SHALL rejeitar qualquer requisição que tente acessar dados de sessões de outros psicólogos, retornando status 403.
7. THE System SHALL não expor IDs internos de psicólogos ou pacientes em URLs públicas — usar apenas `accessToken` para acesso de pacientes.
