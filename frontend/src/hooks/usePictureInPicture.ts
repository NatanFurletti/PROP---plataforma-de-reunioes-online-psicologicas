import { useCallback, useEffect, useMemo, useState } from "react";

// Extensões do Safari (iOS/macOS) que não estão no lib.dom
interface WebKitVideoElement extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: "inline" | "picture-in-picture" | "fullscreen") => void;
  webkitPresentationMode?: string;
}

// "enterpictureinpicture" ainda não está no tipo MediaSessionAction
type PipMediaSessionAction = MediaSessionAction | "enterpictureinpicture";

function hasStandardPip(video: HTMLVideoElement): boolean {
  return (
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled === true &&
    typeof video.requestPictureInPicture === "function" &&
    !video.disablePictureInPicture
  );
}

function hasWebKitPip(video: WebKitVideoElement): boolean {
  return (
    typeof video.webkitSetPresentationMode === "function" &&
    video.webkitSupportsPresentationMode?.("picture-in-picture") === true
  );
}

function isInPip(video: WebKitVideoElement): boolean {
  return (
    document.pictureInPictureElement === video ||
    video.webkitPresentationMode === "picture-in-picture"
  );
}

async function exitPip(video: WebKitVideoElement): Promise<void> {
  if (document.pictureInPictureElement === video) {
    await document.exitPictureInPicture();
  } else if (video.webkitPresentationMode === "picture-in-picture") {
    video.webkitSetPresentationMode?.("inline");
  }
}

function setPipActionHandler(handler: (() => void) | null): boolean {
  if (!("mediaSession" in navigator)) return false;
  try {
    navigator.mediaSession.setActionHandler(
      "enterpictureinpicture" as PipMediaSessionAction as MediaSessionAction,
      handler,
    );
    return true;
  } catch {
    // Navegador não conhece a ação: sem PiP automático
    return false;
  }
}

interface UsePictureInPictureReturn {
  isSupported: boolean;
  isActive: boolean;
  toggle: () => Promise<void>;
}

// Janela flutuante (picture-in-picture) para um <video>. Mostra o vídeo do
// outro participante, com o áudio, enquanto o usuário usa outros apps.
//
// Abrir pelo botão funciona no Chrome (Android e desktop), Edge e Safari.
// Quando o navegador permite, a janela também abre sozinha ao sair da
// página: Chrome via Media Session ("enterpictureinpicture"), Safari via
// autoPictureInPicture.
export const usePictureInPicture = (
  video: HTMLVideoElement | null,
): UsePictureInPictureReturn => {
  // Elemento que está na janela flutuante (null quando fechada)
  const [pipElement, setPipElement] = useState<HTMLVideoElement | null>(null);
  const isActive = video !== null && pipElement === video;

  const isSupported = useMemo(
    () => video !== null && (hasStandardPip(video) || hasWebKitPip(video)),
    [video],
  );

  const enter = useCallback(async () => {
    if (!video) return;
    const v = video as WebKitVideoElement;
    if (hasStandardPip(v)) {
      await v.requestPictureInPicture();
    } else if (hasWebKitPip(v)) {
      v.webkitSetPresentationMode?.("picture-in-picture");
    }
  }, [video]);

  const toggle = useCallback(async () => {
    if (!video) return;
    const v = video as WebKitVideoElement;
    if (isInPip(v)) {
      await exitPip(v);
    } else {
      await enter();
    }
  }, [video, enter]);

  // Acompanha a janela (o usuário pode fechá-la pelo próprio sistema)
  useEffect(() => {
    if (!video) return;
    const v = video as WebKitVideoElement;
    const sync = () => {
      const active = isInPip(v);
      setPipElement((current) => (active ? v : current === v ? null : current));
    };
    v.addEventListener("enterpictureinpicture", sync);
    v.addEventListener("leavepictureinpicture", sync);
    v.addEventListener("webkitpresentationmodechanged", sync);
    // Safari: abre a janela sozinho ao sair da página com o vídeo tocando
    v.setAttribute("autopictureinpicture", "");

    return () => {
      v.removeEventListener("enterpictureinpicture", sync);
      v.removeEventListener("leavepictureinpicture", sync);
      v.removeEventListener("webkitpresentationmodechanged", sync);
      // Saiu da chamada ou trocou de vídeo: não deixa a janela órfã
      if (isInPip(v)) exitPip(v).catch(() => {});
    };
  }, [video]);

  // PiP automático ao trocar de app/aba (Chrome)
  useEffect(() => {
    if (!isSupported) return;
    const registered = setPipActionHandler(() => {
      enter().catch(() => {});
    });
    if (!registered) return;
    return () => {
      setPipActionHandler(null);
    };
  }, [isSupported, enter]);

  return { isSupported, isActive, toggle };
};
