import { useEffect } from "react";

// Impede que a tela apague sozinha durante a chamada. No celular, tela
// bloqueada equivale a app em segundo plano: a câmera é suspensa.
// O navegador solta o bloqueio quando a página fica oculta, então ele é
// pedido de novo sempre que a página volta a ficar visível.
export const useWakeLock = (enabled: boolean): void => {
  useEffect(() => {
    if (!enabled || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let disposed = false;

    const request = async () => {
      if (document.visibilityState !== "visible" || sentinel || requesting) return;
      requesting = true;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (disposed) {
          void lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener("release", () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Sem suporte, economia de bateria ou permissão negada: segue sem
      } finally {
        requesting = false;
      }
    };

    const onVisibilityChange = () => {
      void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void sentinel?.release();
      sentinel = null;
    };
  }, [enabled]);
};
