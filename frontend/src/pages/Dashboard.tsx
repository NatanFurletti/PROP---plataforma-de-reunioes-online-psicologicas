import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../contexts/useSessionStore";
import { authService, sessionService } from "../services/api";

interface Session {
  id: string;
  scheduledAt: string;
  durationMinutes: number;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  accessToken: string;
  createdAt: string;
}

const STATUS_LABELS: Record<Session["status"], string> = {
  SCHEDULED: "Agendada",
  IN_PROGRESS: "Em andamento",
  COMPLETED: "Concluída",
  CANCELLED: "Cancelada",
};

const STATUS_COLORS: Record<Session["status"], string> = {
  SCHEDULED: "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-green-100 text-green-800",
  COMPLETED: "bg-gray-100 text-gray-700",
  CANCELLED: "bg-red-100 text-red-800",
};

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { psychologist, logout: storeLogout } = useAuthStore();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState("");

  // Formulário de nova sessão
  const [showForm, setShowForm] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(50);
  const [formError, setFormError] = useState("");
  const [formLoading, setFormLoading] = useState(false);

  // Feedback "Copiado!"
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setFetchError("");
    try {
      const res = await sessionService.listSessions();
      setSessions(res.data as Session[]);
    } catch {
      setFetchError("Não foi possível carregar as sessões. Tente novamente.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const handleLogout = async () => {
    try {
      await authService.logout();
    } finally {
      storeLogout();
      navigate("/login");
    }
  };

  const handleCopyLink = async (session: Session) => {
    const clientUrl = import.meta.env.VITE_CLIENT_URL || window.location.origin;
    const link = `${clientUrl}/join/${session.accessToken}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedId(session.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      // fallback silencioso — clipboard pode não estar disponível em contextos inseguros
    }
  };

  const handleStart = (session: Session) => {
    navigate(`/call/${session.id}?role=host`);
  };

  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");

    if (!scheduledAt) {
      setFormError("Informe a data e hora da sessão.");
      return;
    }
    if (new Date(scheduledAt) <= new Date()) {
      setFormError("A data e hora devem ser no futuro.");
      return;
    }
    if (durationMinutes < 1) {
      setFormError("A duração deve ser de pelo menos 1 minuto.");
      return;
    }

    setFormLoading(true);
    try {
      await sessionService.createSession({ scheduledAt, durationMinutes });
      setShowForm(false);
      setScheduledAt("");
      setDurationMinutes(50);
      await fetchSessions();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setFormError(axiosErr.response?.data?.error || "Erro ao criar sessão. Tente novamente.");
    } finally {
      setFormLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navbar */}
      <nav className="bg-white shadow">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">PsiConnect</h1>
            <p className="text-sm text-gray-500">Bem-vindo, {psychologist?.name}</p>
          </div>
          <button
            onClick={handleLogout}
            className="text-sm text-red-600 hover:text-red-800 font-medium"
            aria-label="Sair da conta"
          >
            Sair
          </button>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        {/* Cabeçalho + botão nova sessão */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Suas Sessões</h2>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded"
            aria-expanded={showForm}
            aria-controls="new-session-form"
          >
            {showForm ? "Cancelar" : "+ Nova Sessão"}
          </button>
        </div>

        {/* Formulário inline de nova sessão */}
        {showForm && (
          <div
            id="new-session-form"
            className="bg-white rounded-lg shadow p-6"
            role="region"
            aria-label="Formulário de nova sessão"
          >
            <h3 className="text-base font-semibold mb-4 text-gray-800">Agendar Nova Sessão</h3>
            <form onSubmit={handleCreateSession} className="space-y-4">
              <div>
                <label htmlFor="scheduledAt" className="block text-sm font-medium text-gray-700 mb-1">
                  Data e hora
                </label>
                <input
                  id="scheduledAt"
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label htmlFor="durationMinutes" className="block text-sm font-medium text-gray-700 mb-1">
                  Duração (minutos)
                </label>
                <input
                  id="durationMinutes"
                  type="number"
                  min={1}
                  value={durationMinutes}
                  onChange={(e) => setDurationMinutes(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              {formError && <p className="text-red-600 text-sm">{formError}</p>}
              <button
                type="submit"
                disabled={formLoading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded disabled:opacity-50 text-sm"
              >
                {formLoading ? "Criando..." : "Criar Sessão"}
              </button>
            </form>
          </div>
        )}

        {/* Lista de sessões */}
        <div className="bg-white rounded-lg shadow">
          {loading && (
            <div className="p-8 text-center text-gray-500 text-sm" role="status" aria-live="polite">
              Carregando sessões...
            </div>
          )}

          {!loading && fetchError && (
            <div className="p-8 text-center" role="alert">
              <p className="text-red-600 text-sm mb-3">{fetchError}</p>
              <button
                onClick={fetchSessions}
                className="text-blue-600 hover:underline text-sm"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {!loading && !fetchError && sessions.length === 0 && (
            <div className="p-8 text-center text-gray-500 text-sm">
              Nenhuma sessão agendada ainda.
            </div>
          )}

          {!loading && !fetchError && sessions.length > 0 && (
            <ul className="divide-y divide-gray-100" aria-label="Lista de sessões">
              {sessions.map((session) => {
                const { date, time } = formatDateTime(session.scheduledAt);
                const isCopied = copiedId === session.id;
                return (
                  <li key={session.id} className="px-6 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-900">
                          {date} às {time}
                        </span>
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[session.status]}`}
                          aria-label={`Status: ${STATUS_LABELS[session.status]}`}
                        >
                          {STATUS_LABELS[session.status]}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500">Duração: {session.durationMinutes} min</p>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => handleCopyLink(session)}
                        className="text-xs border border-gray-300 hover:border-blue-400 text-gray-700 hover:text-blue-700 px-3 py-1.5 rounded transition-colors"
                        aria-label={isCopied ? "Link copiado" : "Copiar link da sessão"}
                      >
                        {isCopied ? "Copiado!" : "Copiar link"}
                      </button>

                      {session.status === "SCHEDULED" && (
                        <button
                          onClick={() => handleStart(session)}
                          className="text-xs bg-green-600 hover:bg-green-700 text-white font-semibold px-3 py-1.5 rounded"
                          aria-label="Iniciar sessão"
                        >
                          Iniciar
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
};
