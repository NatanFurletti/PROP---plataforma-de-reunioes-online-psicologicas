import React, { useEffect } from "react";
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

const PrivateRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, bootstrapped } = useAuthStore();
  if (!bootstrapped) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />;
};

export function App() {
  const { login, logout, setBootstrapped } = useAuthStore();

  // Bootstrap: tenta restaurar sessão a partir do cookie HTTP-only
  useEffect(() => {
    let cancelled = false;
    authService
      .me()
      .then((res) => {
        if (cancelled) return;
        login(res.data.psychologist);
      })
      .catch(() => {
        if (cancelled) return;
        // Sem sessão válida — segue como anônimo
      })
      .finally(() => {
        if (cancelled) return;
        setBootstrapped(true);
      });

    const onUnauthorized = () => logout();
    window.addEventListener("auth:unauthorized", onUnauthorized);

    return () => {
      cancelled = true;
      window.removeEventListener("auth:unauthorized", onUnauthorized);
    };
  }, [login, logout, setBootstrapped]);

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
        <Route path="/dashboard" element={<PrivateRoute><Dashboard /></PrivateRoute>} />
        <Route path="/call/:sessionId" element={<VideoCall />} />
        <Route path="/" element={<Navigate to="/dashboard" />} />
      </Routes>
    </Router>
  );
}
