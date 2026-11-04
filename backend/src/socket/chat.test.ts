import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_FILE_BYTES,
  MAX_CHAT_TEXT_LENGTH,
  createChatRateLimiter,
  parseChatMessage,
} from "./chat";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from("%PDF-1.7\n...");

describe("parseChatMessage — texto", () => {
  it("aceita texto e remove espaços das pontas", () => {
    expect(parseChatMessage({ text: "  olá  " })).toEqual({ text: "olá" });
  });

  it("mantém quebras de linha e remove caracteres de controle", () => {
    expect(parseChatMessage({ text: "a\r\nb\u0007c" })).toEqual({ text: "a\nbc" });
  });

  it("rejeita mensagem vazia ou só com espaços", () => {
    expect(parseChatMessage({ text: "   " })).toBe("invalid");
    expect(parseChatMessage({})).toBe("invalid");
    expect(parseChatMessage(null)).toBe("invalid");
  });

  it("rejeita texto que não é string", () => {
    expect(parseChatMessage({ text: 42 })).toBe("invalid");
  });

  it("rejeita texto longo demais", () => {
    expect(parseChatMessage({ text: "a".repeat(MAX_CHAT_TEXT_LENGTH + 1) })).toBe("too-large");
    expect(parseChatMessage({ text: "a".repeat(MAX_CHAT_TEXT_LENGTH) })).not.toBe("too-large");
  });
});

describe("parseChatMessage — arquivos", () => {
  it("aceita imagem e define o tipo pela extensão", () => {
    const result = parseChatMessage({ file: { name: "foto.PNG", data: PNG } });
    expect(result).toMatchObject({
      file: { name: "foto.PNG", type: "image/png", size: PNG.length },
    });
  });

  it("aceita documento com legenda", () => {
    const result = parseChatMessage({ text: "segue", file: { name: "laudo.pdf", data: PDF } });
    expect(result).toMatchObject({ text: "segue", file: { type: "application/pdf" } });
  });

  it("aceita ArrayBuffer além de Buffer", () => {
    const data = PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length);
    expect(parseChatMessage({ file: { name: "a.pdf", data } })).toMatchObject({
      file: { size: PDF.length },
    });
  });

  it("rejeita extensão não permitida", () => {
    const html = Buffer.from("<script>alert(1)</script>");
    expect(parseChatMessage({ file: { name: "x.html", data: html } })).toBe("unsupported-type");
    expect(parseChatMessage({ file: { name: "x.svg", data: html } })).toBe("unsupported-type");
    expect(parseChatMessage({ file: { name: "semextensao", data: PDF } })).toBe(
      "unsupported-type",
    );
  });

  it("rejeita conteúdo que não bate com a extensão", () => {
    expect(parseChatMessage({ file: { name: "foto.png", data: PDF } })).toBe("unsupported-type");
    const binary = Buffer.from([0x61, 0x00, 0x62]);
    expect(parseChatMessage({ file: { name: "notas.txt", data: binary } })).toBe(
      "unsupported-type",
    );
  });

  it("rejeita arquivo grande demais", () => {
    const big = Buffer.alloc(MAX_CHAT_FILE_BYTES + 1);
    PDF.copy(big);
    expect(parseChatMessage({ file: { name: "a.pdf", data: big } })).toBe("too-large");
  });

  it("rejeita arquivo vazio ou sem dados binários", () => {
    expect(parseChatMessage({ file: { name: "a.pdf", data: Buffer.alloc(0) } })).toBe("invalid");
    expect(parseChatMessage({ file: { name: "a.pdf", data: "%PDF" } })).toBe("invalid");
  });

  it("tira o caminho e caracteres de controle do nome", () => {
    const result = parseChatMessage({ file: { name: "..\\..\\etc/ev\u0000il.pdf", data: PDF } });
    expect(result).toMatchObject({ file: { name: "evil.pdf" } });
  });

  it("encurta nomes longos mantendo a extensão", () => {
    const result = parseChatMessage({ file: { name: `${"a".repeat(300)}.pdf`, data: PDF } });
    const name = (result as { file: { name: string } }).file.name;
    expect(name.length).toBe(120);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("createChatRateLimiter", () => {
  it("limita a quantidade de mensagens na janela e libera depois", () => {
    let now = 0;
    const allow = createChatRateLimiter(() => now);
    for (let i = 0; i < 10; i++) expect(allow(0)).toBe(true);
    expect(allow(0)).toBe(false);
    now = 10_000;
    expect(allow(0)).toBe(true);
  });

  it("limita o volume de arquivos na janela", () => {
    const allow = createChatRateLimiter(() => 0);
    expect(allow(MAX_CHAT_FILE_BYTES)).toBe(true);
    expect(allow(MAX_CHAT_FILE_BYTES)).toBe(true);
    expect(allow(MAX_CHAT_FILE_BYTES)).toBe(true);
    expect(allow(MAX_CHAT_FILE_BYTES)).toBe(false);
    expect(allow(0)).toBe(true);
  });
});
