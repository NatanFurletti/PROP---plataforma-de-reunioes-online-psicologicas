# Implementation Plan: PsiConnect Platform

## Overview

Implementação incremental da plataforma PsiConnect, partindo da estrutura base existente. As tasks cobrem: configuração do servidor Express, sinalização WebRTC com Socket.IO, autenticação, gerenciamento de sessões, páginas do frontend e integração WebRTC completa.

## Tasks

- [x] 1. Configurar servidor Express com middlewares e rotas
  - [x] 1.1 Registrar `cookie-parser`, rotas de auth e sessão, e middleware global de erros em `backend/src/index.ts`
    - Importar `cookie-parser` e registrá-lo antes das rotas
    - Importar e montar `router` em `/api`
    - Mover lógica Socket.IO para módulo separado
    - Adicionar handler 404 para rotas inexistentes
    - Registrar middleware global de erros como último middleware
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 1.2 Escrever testes unitários para configuração do servidor
    - Verificar que rota inexistente retorna 404
    - Verificar que middleware de erros retorna 500 com formato padronizado
    - _Requirements: 3.5, 3.6_

- [x] 2. Corrigir e completar AuthService e controllers de autenticação
  - [x] 2.1 Implementar validação com `zod` no registro e login em `backend/src/services/index.ts`
    - Validar formato de e-mail, senha ≥ 8 chars, nome obrigatório
    - Retornar 400 com campos inválidos identificados
    - Retornar 409 para e-mail duplicado
    - Garantir que senha é armazenada como hash bcrypt (nunca texto plano)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 2.2 Escrever property test para registro com inputs inválidos (Property 3)
    - **Property 3: Inputs inválidos de registro retornam 400**
    - **Validates: Requirements 1.3, 1.4**
    - Usar `fc.record` com nome curto, e-mail malformado, senha < 8 chars
    - `numRuns: 100`

  - [ ]* 2.3 Escrever property test para e-mail duplicado (Property 2)
    - **Property 2: E-mail duplicado é rejeitado com 409**
    - **Validates: Requirements 1.2**
    - Registrar psicólogo, tentar registrar novamente com mesmo e-mail
    - `numRuns: 100`

  - [x] 2.4 Implementar login com JWT em HTTP-only cookie e logout em `backend/src/services/index.ts`
    - Retornar cookie `jwt` com flag `HttpOnly`, `SameSite=Strict`, expiração 8h
    - Logout deve limpar o cookie (maxAge=0)
    - Credenciais inválidas retornam 401 com mensagem genérica
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [ ]* 2.5 Escrever property test para login com credenciais válidas (Property 4)
    - **Property 4: Login com credenciais válidas define cookie HTTP-only**
    - **Validates: Requirements 2.1, 2.5**
    - Gerar psicólogos com dados válidos aleatórios, verificar cookie na resposta
    - `numRuns: 100`

  - [ ]* 2.6 Escrever property test para rotas protegidas sem token (Property 7)
    - **Property 7: Rotas protegidas rejeitam requisições sem token válido**
    - **Validates: Requirements 2.4, 3.2**
    - Testar todas as rotas protegidas com token ausente/expirado/malformado
    - `numRuns: 100`

- [x] 3. Checkpoint — Garantir que todos os testes de auth passam
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

- [x] 4. Corrigir SessionService e controllers de sessão
  - [x] 4.1 Corrigir `createSession` em `backend/src/services/index.ts`
    - Rejeitar `scheduledAt` no passado com status 400
    - Gerar `accessToken` UUID único
    - Calcular expiração: `scheduledAt + durationMinutes + 30min`
    - _Requirements: 4.1, 4.2, 4.6_

  - [ ]* 4.2 Escrever property test para criação de sessão (Property 8)
    - **Property 8: Criação de sessão persiste no banco com accessToken único**
    - **Validates: Requirements 4.1**
    - Gerar dados válidos aleatórios, verificar persistência e unicidade do token
    - `numRuns: 100`

  - [x] 4.3 Corrigir `validateAccessToken` em `backend/src/services/index.ts`
    - Retornar 404 para token inexistente
    - Retornar 410 para sessões `CANCELLED` ou `COMPLETED`
    - Retornar 410 se `scheduledAt + durationMinutes + 30min` está no passado
    - _Requirements: 5.2, 5.3, 5.4, 5.5_

  - [ ]* 4.4 Escrever property test para validação de token (Property 12)
    - **Property 12: Token inválido → 404; token de sessão indisponível → 410**
    - **Validates: Requirements 5.3, 5.4, 5.5**
    - Gerar tokens inexistentes (404) e sessões canceladas/expiradas (410)
    - `numRuns: 100`

  - [x] 4.5 Corrigir `validateSessionToken` em `backend/src/controllers/index.ts`
    - Retornar `{ sessionId, scheduledAt, durationMinutes, psychologistName }` em caso de sucesso
    - _Requirements: 5.2_

  - [ ]* 4.6 Escrever property test para token válido retorna dados completos (Property 11)
    - **Property 11: Token válido retorna dados completos da sessão**
    - **Validates: Requirements 5.2**
    - Verificar que todos os campos obrigatórios estão presentes na resposta
    - `numRuns: 100`

  - [x] 4.7 Corrigir `getSession` em `backend/src/controllers/index.ts`
    - Verificar que a sessão pertence ao psicólogo autenticado
    - Retornar 403 caso contrário
    - _Requirements: 10.6_

  - [ ]* 4.8 Escrever property test para isolamento de sessões entre psicólogos (Property 10)
    - **Property 10: Listagem retorna apenas sessões do psicólogo autenticado**
    - **Validates: Requirements 4.3, 10.6**
    - Criar dois psicólogos com sessões distintas, verificar isolamento
    - `numRuns: 100`

- [x] 5. Implementar módulo de sinalização Socket.IO
  - [x] 5.1 Criar `backend/src/socket/signalingHandler.ts`
    - Implementar `registerSignalingHandlers(io, prisma)`
    - Manter `Map<sessionId, RoomState>` com participantes por sala
    - Handler `join-room`: verificar limite de 2, adicionar socket, emitir `user-joined`
    - Handler `offer`, `answer`, `ice-candidate`: encaminhar para o outro participante da sala
    - Handler `session-end`: emitir `session-ended`, atualizar status para `COMPLETED` no DB, limpar sala
    - Handler `disconnect`: emitir `user-left`, remover socket do Map, deletar sala se vazia
    - Emitir `room-full` ao rejeitar terceiro participante
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [ ]* 5.2 Escrever property test para limite de participantes (Property 13)
    - **Property 13: Sala limita a exatamente 2 participantes**
    - **Validates: Requirements 7.1**
    - Simular 3 conexões na mesma sala, verificar `room-full` na terceira
    - `numRuns: 100`

  - [ ]* 5.3 Escrever property test para encaminhamento de sinalização (Property 14)
    - **Property 14: Mensagens de sinalização encaminhadas apenas para o par correto**
    - **Validates: Requirements 7.3, 7.4, 7.5**
    - Verificar que offer/answer/ice-candidate chegam apenas ao outro participante da mesma sala
    - `numRuns: 100`

  - [ ]* 5.4 Escrever property test para desconexão emite user-left (Property 15)
    - **Property 15: Desconexão emite user-left para o participante restante**
    - **Validates: Requirements 7.6**
    - Verificar evento `user-left` e remoção da sala quando ambos saem
    - `numRuns: 100`

  - [ ]* 5.5 Escrever property test para session-end atualiza DB (Property 16)
    - **Property 16: session-end atualiza status no banco e emite session-ended**
    - **Validates: Requirements 7.7**
    - Verificar que status muda para `COMPLETED` e `session-ended` é emitido
    - `numRuns: 100`

- [x] 6. Checkpoint — Garantir que todos os testes de backend passam
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

- [x] 7. Implementar páginas de autenticação do frontend
  - [x] 7.1 Criar `frontend/src/pages/Register.tsx`
    - Formulário com campos: nome, e-mail, senha, CRP (opcional)
    - Validação client-side antes de submeter
    - Chamar `POST /api/auth/register`; redirecionar para `/login` em caso de sucesso
    - Exibir erros de validação retornados pelo backend (400, 409)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 7.2 Adicionar rotas `/register` e `/join/:token` em `frontend/src/App.tsx`
    - Importar e registrar `<Register />` e `<JoinSession />` no router
    - _Requirements: 1.5, 5.1_

- [x] 8. Implementar fluxo de acesso do paciente
  - [x] 8.1 Criar `frontend/src/pages/JoinSession.tsx`
    - Ao montar, chamar `GET /api/sessions/join/:token`
    - Exibir "Link inválido" para 404; "Sessão não disponível" para 410
    - Para 200: exibir formulário solicitando nome do paciente
    - Ao submeter: armazenar `{ patientName, token, sessionId }` em `sessionStorage`
    - Navegar para `/call/:sessionId?role=guest`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 8.2 Atualizar `frontend/src/contexts/useSessionStore.ts`
    - Adicionar campos `patientName: string | null` e `accessToken: string | null`
    - Adicionar método `setPatientInfo(name: string, token: string)`
    - _Requirements: 5.6_

  - [x] 8.3 Criar `frontend/src/pages/WaitingRoom.tsx`
    - Exibir mensagem de espera enquanto psicólogo não entrou
    - Manter conexão Socket.IO ativa (emitir `join-room` com role `guest`)
    - Ao receber `user-joined`, navegar para a videochamada
    - Reconexão automática: até 3 tentativas com intervalo de 3s
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 8.4 Criar `frontend/src/pages/SessionEnded.tsx`
    - Tela simples exibida ao paciente após receber `session-ended`
    - Exibir mensagem de encerramento e opção de fechar a aba
    - _Requirements: 9.4_

- [x] 9. Implementar Dashboard funcional
  - [x] 9.1 Refatorar `frontend/src/pages/Dashboard.tsx`
    - `useEffect` para buscar sessões via `GET /api/sessions`
    - Exibir lista com: data, hora, duração, status e botão "Copiar link"
    - Botão "Copiar link" copia `{CLIENT_URL}/join/{accessToken}` para clipboard
    - Botão "Iniciar" navega para `/call/:sessionId?role=host`
    - Modal/formulário para criar nova sessão (data, hora, duração)
    - Chamar `POST /api/sessions` ao submeter; atualizar lista após criação
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 9.2 Escrever testes unitários para Dashboard
    - Verificar que lista de sessões é exibida corretamente
    - Verificar que botão "Copiar link" copia URL correta
    - _Requirements: 4.4, 4.5_

- [x] 10. Implementar hook useWebRTC com integração Socket.IO
  - [x] 10.1 Refatorar `frontend/src/hooks/useWebRTC.ts`
    - Receber `{ sessionId, role, onSessionEnded, onError }` como parâmetros
    - Solicitar permissão de câmera e microfone via `getUserMedia` na inicialização
    - Emitir `join-room` ao conectar ao Socket.IO
    - Registrar listeners: `user-joined`, `offer`, `answer`, `ice-candidate`, `session-ended`
    - Host cria offer ao receber `user-joined`; guest cria answer ao receber `offer`
    - Emitir `ice-candidate` ao gerar candidatos ICE
    - Implementar reconexão: até 3 tentativas antes de chamar `onError`
    - `endCall`: parar todos os tracks, fechar `RTCPeerConnection`, emitir `session-end` se host
    - Usar configurações STUN/TURN de variáveis de ambiente
    - Retornar `{ localStream, remoteStream, isMicMuted, isCameraOff, connectionState, toggleMic, toggleCamera, endCall }`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ]* 10.2 Escrever property test para negação de permissão de mídia (Property 17)
    - **Property 17: getUserMedia rejeitado → connectionState = "failed" + onError chamado**
    - **Validates: Requirements 8.2**
    - Mockar `getUserMedia` para rejeitar, verificar estado e callback
    - `numRuns: 100`

  - [ ]* 10.3 Escrever property test para toggleMic e toggleCamera (Property 18)
    - **Property 18: toggleMic/toggleCamera invertem estado corretamente**
    - **Validates: Requirements 8.5**
    - Gerar estado inicial aleatório (boolean), verificar inversão após toggle
    - `numRuns: 100`

  - [ ]* 10.4 Escrever property test para endCall (Property 19)
    - **Property 19: endCall para todos os tracks e fecha a peer connection**
    - **Validates: Requirements 8.6**
    - Verificar `track.readyState === "ended"` e `RTCPeerConnection.signalingState === "closed"`
    - `numRuns: 100`

- [x] 11. Integrar VideoCall com useWebRTC real
  - [x] 11.1 Refatorar `frontend/src/pages/VideoCall.tsx`
    - Detectar `role` via query param ou `sessionStorage`
    - Integrar `useWebRTC` com `sessionId` e `role` corretos
    - Renderizar `<VideoTile>` para stream local (miniatura) e remoto (destaque)
    - Exibir indicadores visuais: microfone mutado, câmera desativada, status da conexão
    - Exibir indicador de carregamento enquanto `connectionState !== "connected"`
    - Exibir nome do participante remoto abaixo do vídeo
    - Diálogo de confirmação antes de encerrar (apenas para host)
    - Ao receber `session-ended` (via `onSessionEnded`): redirecionar guest para `SessionEnded`, host para `/dashboard`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 11.2 Escrever property test para indicadores visuais (Property 20)
    - **Property 20: Indicadores visuais refletem estado atual dos controles**
    - **Validates: Requirements 9.2**
    - Gerar combinações aleatórias de `isMicMuted`, `isCameraOff`, `connectionState`
    - Verificar que os indicadores renderizados correspondem ao estado
    - `numRuns: 100`

  - [ ]* 11.3 Escrever property test para redirecionamento pós-encerramento (Property 21)
    - **Property 21: Redirecionamento pós-encerramento correto por papel**
    - **Validates: Requirements 9.4**
    - Verificar que host vai para `/dashboard` e guest vai para tela de encerramento
    - `numRuns: 100`

- [x] 12. Checkpoint final — Garantir que todos os testes passam
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

## Notes

- Tasks marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido
- Cada task referencia requisitos específicos para rastreabilidade
- Propriedades PBT usam `fast-check` com `numRuns: 100` mínimo
- Cada property test deve incluir comentário: `// Feature: psiconnect-platform, Property N: <texto>`
- JWT deve ser armazenado exclusivamente em HTTP-only cookies — nunca em `localStorage`
- Streams de mídia devem ser fechados via `stream.getTracks().forEach(t => t.stop())` ao encerrar
- Logs não devem conter dados sensíveis de pacientes (conformidade LGPD)
