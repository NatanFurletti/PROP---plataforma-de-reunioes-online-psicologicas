// Arquivos aceitos no chat da chamada. Espelha a lista do backend
// (backend/src/socket/chat.ts), que é quem decide de fato.

export const MAX_CHAT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_CHAT_TEXT_LENGTH = 2000;

const TYPES_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  odt: "application/vnd.oasis.opendocument.text",
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Valor do atributo `accept` do seletor de arquivos
export const CHAT_FILE_ACCEPT = Object.keys(TYPES_BY_EXTENSION)
  .map((ext) => `.${ext}`)
  .join(",");

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function chatFileType(name: string): string | null {
  return TYPES_BY_EXTENSION[extensionOf(name)] ?? null;
}

// Só tipos de imagem conhecidos são exibidos inline (SVG, por exemplo, não)
export function isChatImage(type: string): boolean {
  return IMAGE_TYPES.has(type);
}

// Mensagem de erro para o usuário, ou null se o arquivo pode ser enviado
export function validateChatFile(file: File): string | null {
  if (!chatFileType(file.name)) {
    return "Tipo de arquivo não permitido. Envie imagens (PNG, JPG, GIF, WEBP) ou documentos (PDF, TXT, DOC, DOCX, ODT, RTF).";
  }
  if (file.size === 0) return "O arquivo está vazio.";
  if (file.size > MAX_CHAT_FILE_BYTES) return "O arquivo passa do limite de 5 MB.";
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}
