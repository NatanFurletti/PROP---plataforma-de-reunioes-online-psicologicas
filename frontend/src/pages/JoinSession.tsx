import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { sessionService } from "../services/api";

type PageState = "loading" | "invalid" | "expired" | "ready";

interface SessionData {
  sessionId: string;
  scheduledAt: string;
  durationMinutes: number;
  psychologistName: string;
}

export const JoinSession: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [pageState, setPageState] = useState<PageState>("loading");
  const [sessionData, setSessionData] = useState<SessionData | null>(null);
  const [patientName, setPatientName] = useState("");
  const [nameError, setNameError] = useState("");

  useEffect(() => {
    if (!token) {
      setPageState("invalid");
      return;
    }

    sessionService
      .validateSessionToken(token)
      .then((res) => {
        setSessionData(res.data);
        setPageState("ready");
      })
      .catch((err: unknown) => {
        const axiosErr = err as { response?: { status: number } };
        if (axiosErr.response?.status === 410) {
          setPageState("expired");
        } else {
          setPageState("invalid");
        }
      });
  }, [token]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!patientName.trim()) {
      setNameError("Por favor, informe seu nome");
      return;
    }
    if (!sessionData || !token) return;

    sessionStorage.setItem(
      "patientSession",
      JSON.stringify({
        patientName: patientName.trim(),
        accessToken: token,
        sessionId: sessionData.sessionId,
      }),
    );

    navigate(`/call/${sessionData.sessionId}?role=guest`);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-2">PsiConnect</h1>

        {pageState === "loading" && (
          <p className="text-center text-gray-500 mt-4">Carregando sessão...</p>
        )}

        {pageState === "invalid" && (
          <div className="text-center mt-4">
            <p className="text-red-600 font-semibold">Link inválido ou não encontrado</p>
            <p className="text-gray-500 text-sm mt-2">
              Verifique o link recebido e tente novamente.
            </p>
          </div>
        )}

        {pageState === "expired" && (
          <div className="text-center mt-4">
            <p className="text-orange-600 font-semibold">Esta sessão não está mais disponível</p>
            <p className="text-gray-500 text-sm mt-2">
              A sessão foi encerrada ou o link expirou.
            </p>
          </div>
        )}

        {pageState === "ready" && sessionData && (
          <>
            <p className="text-center text-gray-500 text-sm mb-4">
              Você foi convidado para uma sessão
            </p>

            <div className="bg-blue-50 rounded-lg p-4 mb-6 text-sm text-gray-700 space-y-1">
              <p>
                <span className="font-medium">Psicólogo:</span> {sessionData.psychologistName}
              </p>
              <p>
                <span className="font-medium">Data:</span> {formatDate(sessionData.scheduledAt)}
              </p>
              <p>
                <span className="font-medium">Horário:</span> {formatTime(sessionData.scheduledAt)}
              </p>
              <p>
                <span className="font-medium">Duração:</span> {sessionData.durationMinutes} minutos
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <input
                  type="text"
                  placeholder="Seu nome completo"
                  value={patientName}
                  onChange={(e) => {
                    setPatientName(e.target.value);
                    if (nameError) setNameError("");
                  }}
                  className="w-full border border-gray-300 rounded px-3 py-2"
                  aria-label="Seu nome completo"
                  autoFocus
                />
                {nameError && <p className="text-red-600 text-xs mt-1">{nameError}</p>}
              </div>

              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded"
              >
                Entrar na sessão
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
