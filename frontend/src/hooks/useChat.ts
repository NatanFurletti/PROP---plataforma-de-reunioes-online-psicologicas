import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { chatFileType, validateChatFile, MAX_CHAT_TEXT_LENGTH } from "../utils/chatFiles";

export interface ChatAttachment {
  name: string;
  type: string;
  size: number;
  // URL local (blob:) para exibir ou baixar
  url: string;
}

export interface ChatMessage {
  id: string;
  mine: boolean;
  senderName: string;
  senderRole: "host" | "guest";
  text?: string;
  file?: ChatAttachment;
  sentAt: string;
  status: "sending" | "sent" | "failed";
  // Motivo da falha no envio, já em linguagem para o usuário
  error?: string;
}

// Mensagem como chega do servidor
interface IncomingChatMessage {
  id: string;
  from: string;
  senderName: string;
  senderRole: "host" | "guest";
  sentAt: string;
  text?: string;
  file?: { name: string; type: string; size: number; data: ArrayBuffer };
}

type ChatAck = { ok: true; id: string; sentAt: string } | { ok: false; error: string };

interface UseChatOptions {
  socket: Socket | null;
  // Só quem está na chamada usa o chat (paciente em espera não)
  enabled: boolean;
  // Painel aberto: mensagens recebidas não contam como não lidas
  isOpen: boolean;
  selfName: string;
  selfRole: "host" | "guest";
}

interface UseChatReturn {
  messages: ChatMessage[];
  unreadCount: number;
  // Resolve com um erro para o usuário se a mensagem não pôde ser enviada
  // (arquivo inválido, fora da chamada), ou null quando ela entra na
  // conversa. A confirmação do servidor chega depois, no `status`.
  sendMessage: (text: string, file?: File | null) => Promise<string | null>;
}

// Upload de até 5 MB numa conexão móvel lenta pode demorar
const SEND_TIMEOUT_MS = 60_000;

const SERVER_ERRORS: Record<string, string> = {
  "not-in-call": "Você não está na chamada.",
  "too-large": "A mensagem ou o arquivo passa do limite permitido.",
  "unsupported-type": "Tipo de arquivo não permitido ou arquivo corrompido.",
  "rate-limited": "Muitas mensagens em pouco tempo. Aguarde alguns segundos.",
  invalid: "Mensagem inválida.",
};

let localCounter = 0;
const nextLocalId = () => `local-${Date.now()}-${++localCounter}`;

// Chat da chamada sobre o socket de sinalização. Nada é gravado: as
// mensagens existem só na memória desta aba e somem ao sair.
export const useChat = ({
  socket,
  enabled,
  isOpen,
  selfName,
  selfRole,
}: UseChatOptions): UseChatReturn => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  // Abrir o painel zera as não lidas (ajuste durante o render, sem efeito)
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) setUnreadCount(0);
  }

  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // URLs blob: criadas para anexos; liberadas ao sair da chamada
  const objectUrlsRef = useRef<string[]>([]);
  const createUrl = useCallback((data: Blob) => {
    const url = URL.createObjectURL(data);
    objectUrlsRef.current.push(url);
    return url;
  }, []);
  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.length = 0;
    };
  }, []);

  useEffect(() => {
    if (!socket || !enabled) return;

    const onMessage = (incoming: IncomingChatMessage) => {
      let file: ChatAttachment | undefined;
      if (incoming.file) {
        const { name, size, data } = incoming.file;
        // O tipo é refeito pela extensão: não confia no que veio da rede
        const type = chatFileType(name) ?? "application/octet-stream";
        file = { name, type, size, url: createUrl(new Blob([data], { type })) };
      }
      setMessages((prev) =>
        prev.some((m) => m.id === incoming.id)
          ? prev
          : [
              ...prev,
              {
                id: incoming.id,
                mine: false,
                senderName: incoming.senderName,
                senderRole: incoming.senderRole,
                text: incoming.text,
                file,
                sentAt: incoming.sentAt,
                status: "sent",
              },
            ],
      );
      if (!isOpenRef.current) setUnreadCount((n) => n + 1);
    };

    socket.on("chat-message", onMessage);
    return () => {
      socket.off("chat-message", onMessage);
    };
  }, [socket, enabled, createUrl]);

  const sendMessage = useCallback(
    async (rawText: string, file?: File | null): Promise<string | null> => {
      const text = rawText.trim();
      if (!text && !file) return null;
      if (!socket || !enabled) return SERVER_ERRORS["not-in-call"];
      if (text.length > MAX_CHAT_TEXT_LENGTH) {
        return `A mensagem passa do limite de ${MAX_CHAT_TEXT_LENGTH} caracteres.`;
      }

      let attachment: ChatAttachment | undefined;
      let data: ArrayBuffer | undefined;
      if (file) {
        const invalid = validateChatFile(file);
        if (invalid) return invalid;
        const type = chatFileType(file.name)!;
        try {
          data = await file.arrayBuffer();
        } catch {
          return "Não foi possível ler o arquivo.";
        }
        attachment = { name: file.name, type, size: file.size, url: createUrl(file) };
      }

      const localId = nextLocalId();
      setMessages((prev) => [
        ...prev,
        {
          id: localId,
          mine: true,
          senderName: selfName,
          senderRole: selfRole,
          text: text || undefined,
          file: attachment,
          sentAt: new Date().toISOString(),
          status: "sending",
        },
      ]);

      const payload = {
        ...(text ? { text } : {}),
        ...(file && data ? { file: { name: file.name, data } } : {}),
      };

      const fail = (error: string) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === localId ? { ...m, status: "failed", error } : m)),
        );

      socket
        .timeout(SEND_TIMEOUT_MS)
        .emit("chat-message", payload, (err: Error | null, ack?: ChatAck) => {
          if (err || !ack) {
            fail("Não foi possível enviar. Verifique sua conexão.");
          } else if (!ack.ok) {
            fail(SERVER_ERRORS[ack.error] ?? SERVER_ERRORS.invalid);
          } else {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === localId
                  ? { ...m, id: ack.id, sentAt: ack.sentAt, status: "sent" }
                  : m,
              ),
            );
          }
        });
      return null;
    },
    [socket, enabled, selfName, selfRole, createUrl],
  );

  return { messages, unreadCount, sendMessage };
};
