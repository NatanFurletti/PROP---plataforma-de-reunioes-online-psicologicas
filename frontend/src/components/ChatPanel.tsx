import React, { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../hooks/useChat";
import {
  CHAT_FILE_ACCEPT,
  MAX_CHAT_TEXT_LENGTH,
  formatFileSize,
  isChatImage,
  validateChatFile,
} from "../utils/chatFiles";

interface ChatPanelProps {
  messages: ChatMessage[];
  onSend: (text: string, file: File | null) => Promise<string | null>;
  onClose: () => void;
}

function senderLabel(message: ChatMessage): string {
  if (message.mine) return "Você";
  return message.senderRole === "host" ? "Psicólogo" : message.senderName;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const Attachment: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const file = message.file!;
  if (isChatImage(file.type)) {
    return (
      <a
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block mt-1"
        aria-label={`Abrir imagem ${file.name}`}
      >
        <img
          src={file.url}
          alt={file.name}
          className="max-h-48 max-w-full rounded-md object-contain bg-black/20"
        />
      </a>
    );
  }
  return (
    <a
      href={file.url}
      download={file.name}
      className="mt-1 flex items-center gap-2 rounded-md bg-black/20 px-3 py-2 hover:bg-black/30"
      aria-label={`Baixar ${file.name}`}
    >
      <span aria-hidden="true">📄</span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{file.name}</span>
        <span className="block text-xs opacity-75">{formatFileSize(file.size)}</span>
      </span>
    </a>
  );
};

// Painel lateral do chat da chamada (tela cheia no celular)
export const ChatPanel: React.FC<ChatPanelProps> = ({ messages, onSend, onClose }) => {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const listEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Rola até a mensagem mais recente
  useEffect(() => {
    listEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  const pickFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    // Permite escolher o mesmo arquivo de novo depois de remover
    event.target.value = "";
    if (!picked) return;
    const invalid = validateChatFile(picked);
    setError(invalid);
    setFile(invalid ? null : picked);
  };

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy || (!text.trim() && !file)) return;
    setBusy(true);
    const result = await onSend(text, file);
    setBusy(false);
    setError(result);
    if (!result) {
      setText("");
      setFile(null);
      textareaRef.current?.focus();
    }
  };

  // Enter envia; Shift+Enter quebra a linha
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <aside
      aria-label="Chat da sessão"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      className="fixed inset-0 z-40 flex flex-col bg-gray-900 sm:static sm:z-auto sm:w-80 sm:border-l sm:border-gray-800"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <h2 className="text-white font-semibold">Chat</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white px-2 py-1 rounded"
          aria-label="Fechar chat"
        >
          ✕
        </button>
      </header>

      <div role="log" aria-live="polite" className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <p className="text-xs text-gray-500 text-center">
          As mensagens e arquivos não são salvos e somem ao sair da chamada.
        </p>
        {messages.map((message) => (
          <div
            key={message.id}
            className={`flex flex-col ${message.mine ? "items-end" : "items-start"}`}
          >
            <span className="text-xs text-gray-400 mb-0.5">
              {senderLabel(message)} · {formatTime(message.sentAt)}
            </span>
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm text-white break-words ${
                message.mine ? "bg-blue-600" : "bg-gray-700"
              } ${message.status === "sending" ? "opacity-70" : ""}`}
            >
              {message.text && <p className="whitespace-pre-wrap">{message.text}</p>}
              {message.file && <Attachment message={message} />}
            </div>
            {message.status === "sending" && (
              <span className="text-xs text-gray-500 mt-0.5">Enviando...</span>
            )}
            {message.status === "failed" && (
              <span role="alert" className="text-xs text-red-400 mt-0.5">
                Não enviada: {message.error}
              </span>
            )}
          </div>
        ))}
        <div ref={listEndRef} />
      </div>

      <form onSubmit={submit} className="border-t border-gray-800 p-3 space-y-2">
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        {file && (
          <div className="flex items-center justify-between gap-2 rounded-md bg-gray-800 px-3 py-2 text-sm text-gray-200">
            <span className="truncate">
              📎 {file.name} <span className="text-gray-400">({formatFileSize(file.size)})</span>
            </span>
            <button
              type="button"
              onClick={() => setFile(null)}
              className="text-gray-400 hover:text-white"
              aria-label={`Remover anexo ${file.name}`}
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={CHAT_FILE_ACCEPT}
            onChange={pickFile}
            className="hidden"
            data-testid="chat-file-input"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded-full bg-gray-700 hover:bg-gray-600 text-white w-10 h-10"
            aria-label="Anexar imagem ou documento"
            title="Anexar imagem ou documento (até 10 MB)"
          >
            📎
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={MAX_CHAT_TEXT_LENGTH}
            placeholder="Escreva uma mensagem"
            aria-label="Mensagem"
            className="flex-1 resize-none rounded-lg bg-gray-800 text-white text-sm px-3 py-2 max-h-32 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={busy || (!text.trim() && !file)}
            className="shrink-0 rounded-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 h-10 text-sm font-semibold"
          >
            Enviar
          </button>
        </div>
      </form>
    </aside>
  );
};
