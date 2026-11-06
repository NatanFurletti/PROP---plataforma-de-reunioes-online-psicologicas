import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { VideoTile } from "./VideoTile";

describe("VideoTile", () => {
  it("mostra o vídeo sem avatar por padrão", () => {
    render(<VideoTile stream={null} label="Maria" />);
    expect(screen.queryByTestId("video-placeholder")).toBeNull();
  });

  it("cobre o vídeo parado com avatar e status, mantendo o <video> para o áudio", () => {
    const { container } = render(
      <VideoTile stream={null} label="Maria" showVideo={false} status="Reconectando..." />,
    );
    expect(screen.getByTestId("video-placeholder")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Reconectando...");
    expect(screen.getByText("M")).toBeTruthy();
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("mostra o ícone de microfone desligado só quando mutado", () => {
    const { rerender } = render(<VideoTile stream={null} label="Maria" />);
    expect(screen.queryByTestId("mic-muted-icon")).toBeNull();
    rerender(<VideoTile stream={null} label="Maria" isMicMuted />);
    expect(screen.getByRole("img", { name: "Microfone desligado" })).toBeTruthy();
  });

  it("botão de mutar chama onMuteMic e some quando já está mutado", () => {
    const onMuteMic = vi.fn();
    const { rerender } = render(
      <VideoTile stream={null} label="Maria" onMuteMic={onMuteMic} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Desligar o microfone de Maria" }));
    expect(onMuteMic).toHaveBeenCalledTimes(1);

    rerender(<VideoTile stream={null} label="Maria" onMuteMic={onMuteMic} isMicMuted />);
    expect(screen.queryByRole("button", { name: /Desligar o microfone/ })).toBeNull();
  });

  it("sem onMuteMic não há botão de mutar", () => {
    render(<VideoTile stream={null} label="Maria" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
