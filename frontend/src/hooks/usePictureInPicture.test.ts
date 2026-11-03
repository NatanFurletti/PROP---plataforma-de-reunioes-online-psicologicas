import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePictureInPicture } from "./usePictureInPicture";

// jsdom não implementa picture-in-picture: simula a API padrão
function stubStandardPip(video: HTMLVideoElement) {
  let pipElement: Element | null = null;
  Object.defineProperty(document, "pictureInPictureEnabled", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pipElement,
  });
  const exit = vi.fn(async () => {
    pipElement = null;
    video.dispatchEvent(new Event("leavepictureinpicture"));
  });
  Object.defineProperty(document, "exitPictureInPicture", {
    configurable: true,
    value: exit,
  });
  const request = vi.fn(async () => {
    pipElement = video;
    video.dispatchEvent(new Event("enterpictureinpicture"));
    return {} as PictureInPictureWindow;
  });
  video.requestPictureInPicture = request;
  return { request, exit };
}

function stubMediaSession() {
  const setActionHandler = vi.fn();
  const mediaSession = {
    setActionHandler,
    metadata: null as unknown,
    playbackState: "none",
  };
  vi.stubGlobal("navigator", { ...globalThis.navigator, mediaSession });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(public init: MediaMetadataInit) {}
    },
  );
  return { setActionHandler, mediaSession };
}

beforeEach(() => {
  Object.defineProperty(document, "pictureInPictureEnabled", {
    configurable: true,
    value: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usePictureInPicture", () => {
  it("sem vídeo não é suportado", () => {
    const { result } = renderHook(() => usePictureInPicture(null));
    expect(result.current.isSupported).toBe(false);
    expect(result.current.isActive).toBe(false);
  });

  it("navegador sem PiP não é suportado", () => {
    const video = document.createElement("video");
    const { result } = renderHook(() => usePictureInPicture(video));
    expect(result.current.isSupported).toBe(false);
  });

  it("abre e fecha a janela pela API padrão", async () => {
    const video = document.createElement("video");
    const { request, exit } = stubStandardPip(video);
    const { result } = renderHook(() => usePictureInPicture(video));
    expect(result.current.isSupported).toBe(true);

    await act(() => result.current.toggle());
    expect(request).toHaveBeenCalled();
    expect(result.current.isActive).toBe(true);

    await act(() => result.current.toggle());
    expect(exit).toHaveBeenCalled();
    expect(result.current.isActive).toBe(false);
  });

  it("usa o modo de apresentação do Safari quando não há API padrão", async () => {
    const video = document.createElement("video") as HTMLVideoElement & {
      webkitPresentationMode?: string;
      webkitSupportsPresentationMode?: (mode: string) => boolean;
      webkitSetPresentationMode?: (mode: string) => void;
    };
    video.webkitPresentationMode = "inline";
    video.webkitSupportsPresentationMode = () => true;
    video.webkitSetPresentationMode = vi.fn((mode: string) => {
      video.webkitPresentationMode = mode;
      video.dispatchEvent(new Event("webkitpresentationmodechanged"));
    });

    const { result } = renderHook(() => usePictureInPicture(video));
    expect(result.current.isSupported).toBe(true);

    await act(() => result.current.toggle());
    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith("picture-in-picture");
    expect(result.current.isActive).toBe(true);

    await act(() => result.current.toggle());
    expect(video.webkitSetPresentationMode).toHaveBeenLastCalledWith("inline");
    expect(result.current.isActive).toBe(false);
  });

  it("registra o PiP automático na Media Session e remove ao desmontar", async () => {
    const { setActionHandler, mediaSession } = stubMediaSession();
    const video = document.createElement("video");
    const { request } = stubStandardPip(video);
    const { unmount } = renderHook(() => usePictureInPicture(video));

    // Marca a página como "tocando mídia" para o navegador abrir sozinho
    expect(mediaSession.playbackState).toBe("playing");
    expect(mediaSession.metadata).not.toBeNull();
    expect(video.hasAttribute("autopictureinpicture")).toBe(true);

    expect(setActionHandler).toHaveBeenCalledWith(
      "enterpictureinpicture",
      expect.any(Function),
    );
    const handler = setActionHandler.mock.calls[0][1] as () => void;
    await act(async () => handler());
    expect(request).toHaveBeenCalled();

    unmount();
    expect(setActionHandler).toHaveBeenLastCalledWith("enterpictureinpicture", null);
    expect(mediaSession.playbackState).toBe("none");
  });

  it("fecha a janela quando o vídeo sai da chamada", async () => {
    const video = document.createElement("video");
    const { exit } = stubStandardPip(video);
    const { result, rerender } = renderHook(
      ({ el }: { el: HTMLVideoElement | null }) => usePictureInPicture(el),
      { initialProps: { el: video as HTMLVideoElement | null } },
    );
    await act(() => result.current.toggle());

    rerender({ el: null });
    expect(exit).toHaveBeenCalled();
    expect(result.current.isActive).toBe(false);
  });
});
