import React, { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./contexts/useSessionStore";
import { authService } from "./services/api";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Dashboard } from "./pages/Dashboard";
import { VideoCall } from "./pages/VideoCall";
import { JoinSession } from "./pages/JoinSession";
import { SessionEnded } from "./pages/SessionEnded";
import { VerifyEmail } from "./pages/VerifyEmail";
import { ForgotPassword } from "./pages/ForgotPassword";
import { ResetPassword } from "./pages/ResetPassword";

// O plano gratuito do Render dorme sem tráfego e leva até ~1 min para
// acordar. Cada tentativa tem timeout; só desistimos depois de algumas.
const BOOTSTRAP_ATTEMPT_TIMEOUT_MS = 25_000;
const BOOTSTRAP_MAX_ATTEMPTS = 3;
const SLOW_HINT_DELAY_MS = 4_000;

// 401/403 = servidor respondeu e não há sessão; o resto (rede, timeout,
// 502/504 do proxy da Vercel) indica servidor indisponível
const isServerUnavailable = (error: unknown): boolean => {
  if (!axios.isAxiosError(error)) return true;
  const status = error.response?.status;
  return status === undefined || status >= 500;
};

const LoadingScreen = () => {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_HINT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-4 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <p className="text-gray-600">Carregando…</p>
      {slow && (
        <p className="text-sm text-gray-500 max-w-xs">
          O servidor está iniciando. Isso pode levar até um minuto.
        </p>
      )}
    </div>
  );
};

interface PrivateRouteProps {
  children: React.ReactNode;
  onRetry: () => void;
}

const PrivateRoute = ({ children, onRetry }: PrivateRouteProps) => {
  const { isAuthenticated, bootstrapped, bootstrapFailed } = useAuthStore();
  if (bootstrapFailed) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-gray-50 px-4 text-center">
        <p className="text-gray-700">Não foi possível conectar ao servidor.</p>
        <button
          type="button"
          onClick={onRetry}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          Tentar novamente
        </button>
      </div>
    );
  }
  if (!bootstrapped) return <LoadingScreen />;
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
};

export function App() {
  const { login, logout, setBootstrapped, setBootstrapFailed } = useAuthStore();
  // Incrementar dispara uma nova rodada de bootstrap (botão "Tentar novamente")
  const [bootstrapRun, setBootstrapRun] = useState(0);
  const retryBootstrap = useCallback(() => {
    setBootstrapFailed(false);
    setBootstrapRun((n) => n + 1);
  }, [setBootstrapFailed]);

  // Bootstrap: tenta restaurar sessão a partir do cookie HTTP-only
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
        try {
          const res = await authService.me(BOOTSTRAP_ATTEMPT_TIMEOUT_MS);
          if (cancelled) return;
          login(res.data.psychologist);
          setBootstrapped(true);
          return;
        } catch (error) {
          if (cancelled) return;
          if (!isServerUnavailable(error)) {
            // Sem sessão válida — segue como anônimo
            setBootstrapped(true);
            return;
          }
        }
      }
      if (!cancelled) setBootstrapFailed(true);
    };
    void run();

    return () => {
      cancelled = true;
    };
  }, [bootstrapRun, login, setBootstrapped, setBootstrapFailed]);

  useEffect(() => {
    const onUnauthorized = () => logout();
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, [logout]);

  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify-email/:token" element={<VerifyEmail />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="/join/:token" element={<JoinSession />} />
        <Route path="/session-ended" element={<SessionEnded />} />
        <Route path="/dashboard" element={<PrivateRoute onRetry={retryBootstrap}><Dashboard /></PrivateRoute>} />
        <Route path="/call/:sessionId" element={<VideoCall />} />
        <Route path="/" element={<Navigate to="/dashboard" />} />
      </Routes>
    </Router>
  );
}
