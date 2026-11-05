// Chat da chamada: validação das mensagens e dos arquivos compartilhados.
//
// O servidor só repassa as mensagens aos participantes da sala — nada é
// gravado (texto ou arquivo). Quem entra depois não vê o que já foi dito.

export const MAX_CHAT_TEXT_LENGTH = 2000;
export const MAX_CHAT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 120;

// Limite de um pacote do Socket.IO. O arquivo vai como anexo binário, que
// tem esse limite próprio; a folga cobre o restante da mensagem.
export const MAX_SOCKET_PAYLOAD_BYTES = MAX_CHAT_FILE_BYTES + 64 * 1024;

// Limites por socket, para um participante não inundar a sala
const RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 10;
const MAX_FILE_BYTES_PER_WINDOW = 3 * MAX_CHAT_FILE_BYTES;

// Tipos aceitos, decididos pela extensão. O tipo informado pelo navegador
// não é confiável (varia por sistema), então o servidor define o tipo
// entregue e confere a assinatura do conteúdo quando ela existe.
interface AllowedType {
  mime: string;
  signature?: (data: Buffer) => boolean;
}

const startsWith = (data: Buffer, bytes: number[]): boolean =>
  data.length >= bytes.length && bytes.every((b, i) => data[i] === b);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];

const ALLOWED_TYPES: Record<string, AllowedType> = {
  png: { mime: "image/png", signature: (d) => startsWith(d, [0x89, 0x50, 0x4e, 0x47]) },
  jpg: { mime: "image/jpeg", signature: (d) => startsWith(d, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: "image/jpeg", signature: (d) => startsWith(d, [0xff, 0xd8, 0xff]) },
  gif: { mime: "image/gif", signature: (d) => startsWith(d, ascii("GIF8")) },
  webp: {
    mime: "image/webp",
    signature: (d) =>
      startsWith(d, ascii("RIFF")) && d.subarray(8, 12).toString("latin1") === "WEBP",
  },
  pdf: { mime: "application/pdf", signature: (d) => startsWith(d, ascii("%PDF")) },
  txt: {
    mime: "text/plain",
    // Texto não tem assinatura; byte nulo indica arquivo binário renomeado
    signature: (d) => !d.subarray(0, 4096).includes(0),
  },
  rtf: { mime: "application/rtf", signature: (d) => startsWith(d, ascii("{\\rtf")) },
  doc: { mime: "application/msword", signature: (d) => startsWith(d, OLE) },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    signature: (d) => startsWith(d, ZIP),
  },
  odt: {
    mime: "application/vnd.oasis.opendocument.text",
    signature: (d) => startsWith(d, ZIP),
  },
};

export const ALLOWED_CHAT_EXTENSIONS = Object.keys(ALLOWED_TYPES);

export type ChatError =
  | "not-in-call"
  | "invalid"
  | "too-large"
  | "unsupported-type"
  | "rate-limited";

export interface ChatFile {
  name: string;
  type: string;
  size: number;
  data: Buffer;
}

export interface ParsedChatMessage {
  text?: string;
  file?: ChatFile;
}

// Remove caracteres de controle, mantendo quebras de linha e tabulação
function cleanText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
}

// Nome exibido e usado no download: sem caminho nem caracteres de controle
function cleanFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const base = raw.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  if (trimmed.length <= MAX_FILE_NAME_LENGTH) return trimmed;
  // Corta o meio e mantém a extensão
  const dot = trimmed.lastIndexOf(".");
  const ext = dot > 0 ? trimmed.slice(dot) : "";
  return trimmed.slice(0, MAX_FILE_NAME_LENGTH - ext.length) + ext;
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function parseFile(raw: unknown): ChatFile | ChatError {
  if (typeof raw !== "object" || raw === null) return "invalid";
  const { name, data } = raw as { name?: unknown; data?: unknown };
  if (typeof name !== "string") return "invalid";

  const buffer = toBuffer(data);
  if (!buffer || buffer.length === 0) return "invalid";
  if (buffer.length > MAX_CHAT_FILE_BYTES) return "too-large";

  const cleanName = cleanFileName(name);
  const dot = cleanName.lastIndexOf(".");
  if (dot <= 0) return "unsupported-type";
  const allowed = ALLOWED_TYPES[cleanName.slice(dot + 1).toLowerCase()];
  if (!allowed) return "unsupported-type";
  if (allowed.signature && !allowed.signature(buffer)) return "unsupported-type";

  return { name: cleanName, type: allowed.mime, size: buffer.length, data: buffer };
}

// Valida o payload de `chat-message`: texto, arquivo ou os dois
export function parseChatMessage(payload: unknown): ParsedChatMessage | ChatError {
  if (typeof payload !== "object" || payload === null) return "invalid";
  const { text, file } = payload as { text?: unknown; file?: unknown };

  const result: ParsedChatMessage = {};

  if (text !== undefined && text !== null) {
    if (typeof text !== "string") return "invalid";
    const cleaned = cleanText(text);
    if (cleaned.length > MAX_CHAT_TEXT_LENGTH) return "too-large";
    if (cleaned.length > 0) result.text = cleaned;
  }

  if (file !== undefined && file !== null) {
    const parsed = parseFile(file);
    if (typeof parsed === "string") return parsed;
    result.file = parsed;
  }

  if (!result.text && !result.file) return "invalid";
  return result;
}

// Janela deslizante por socket: quantidade de mensagens e volume de arquivos
export function createChatRateLimiter(now: () => number = Date.now) {
  const sent: { at: number; bytes: number }[] = [];

  return (fileBytes: number): boolean => {
    const t = now();
    while (sent.length > 0 && t - sent[0].at >= RATE_WINDOW_MS) sent.shift();

    const bytes = sent.reduce((sum, s) => sum + s.bytes, 0);
    if (sent.length >= MAX_MESSAGES_PER_WINDOW) return false;
    if (bytes + fileBytes > MAX_FILE_BYTES_PER_WINDOW) return false;

    sent.push({ at: t, bytes: fileBytes });
    return true;
  };
}
