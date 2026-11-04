import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatPanel } from "./ChatPanel";
import type { ChatMessage } from "../hooks/useChat";

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    mine: false,
    senderName: "Maria",
    senderRole: "guest",
    sentAt: "2026-11-04T12:00:00.000Z",
    status: "sent",
    ...overrides,
  };
}

type SendFn = (text: string, file: File | null) => Promise<string | null>;

function setup(
  messages: ChatMessage[] = [],
  onSend = vi.fn<SendFn>(async () => null),
) {
  const onClose = vi.fn();
  render(<ChatPanel messages={messages} onSend={onSend} onClose={onClose} />);
  return { onSend, onClose };
}

describe("ChatPanel", () => {
  it("mostra texto como texto (sem interpretar HTML) e quem enviou", () => {
    setup([
      message({ text: "<b>oi</b>" }),
      message({ id: "m2", mine: true, text: "tudo bem?" }),
      message({ id: "m3", senderRole: "host", senderName: "Psicólogo", text: "olá" }),
    ]);
    expect(screen.getByText("<b>oi</b>")).toBeInTheDocument();
    expect(screen.getByText(/^Maria ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Você ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Psicólogo ·/)).toBeInTheDocument();
  });

  it("envia com Enter e limpa o campo", async () => {
    const { onSend } = setup();
    const input = screen.getByLabelText("Mensagem");
    await userEvent.type(input, "bom dia{Enter}");
    expect(onSend).toHaveBeenCalledWith("bom dia", null);
    expect(input).toHaveValue("");
  });

  it("Shift+Enter quebra a linha sem enviar", async () => {
    const { onSend } = setup();
    const input = screen.getByLabelText("Mensagem");
    await userEvent.type(input, "a{Shift>}{Enter}{/Shift}b");
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("a\nb");
  });

  it("mantém o texto e mostra o erro quando o envio é recusado", async () => {
    const { onSend } = setup([], vi.fn<SendFn>(async () => "Você não está na chamada."));
    const input = screen.getByLabelText("Mensagem");
    await userEvent.type(input, "oi{Enter}");
    expect(onSend).toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("Você não está na chamada.");
    expect(input).toHaveValue("oi");
  });

  it("anexa arquivo permitido e envia junto", async () => {
    const { onSend } = setup();
    const file = new File(["%PDF"], "laudo.pdf");
    await userEvent.upload(screen.getByTestId("chat-file-input"), file);
    expect(screen.getByText(/laudo\.pdf/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSend).toHaveBeenCalledWith("", file);
  });

  it("recusa arquivo de tipo não permitido", () => {
    setup();
    const input = screen.getByTestId("chat-file-input");
    // fireEvent: o upload do userEvent respeitaria o `accept` e ignoraria o arquivo
    fireEvent.change(input, { target: { files: [new File(["x"], "virus.exe")] } });
    expect(screen.getByRole("alert")).toHaveTextContent(/não permitido/);
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("exibe imagem inline e documento como download", () => {
    setup([
      message({ file: { name: "foto.png", type: "image/png", size: 10, url: "blob:img" } }),
      message({
        id: "m2",
        file: { name: "laudo.pdf", type: "application/pdf", size: 2048, url: "blob:doc" },
      }),
    ]);
    expect(screen.getByRole("img", { name: "foto.png" })).toHaveAttribute("src", "blob:img");
    const download = screen.getByRole("link", { name: "Baixar laudo.pdf" });
    expect(download).toHaveAttribute("download", "laudo.pdf");
    expect(download).toHaveAttribute("href", "blob:doc");
  });

  it("mostra falha no envio de uma mensagem", () => {
    setup([message({ mine: true, text: "oi", status: "failed", error: "Sem conexão." })]);
    expect(screen.getByRole("alert")).toHaveTextContent("Não enviada: Sem conexão.");
  });

  it("fecha pelo botão e pela tecla Escape", async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Fechar chat" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
