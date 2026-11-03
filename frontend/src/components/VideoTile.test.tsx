import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
