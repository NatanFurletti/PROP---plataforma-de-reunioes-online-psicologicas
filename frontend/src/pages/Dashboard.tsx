import React from "react";
import { useAuthStore } from "../contexts/useSessionStore";

export const Dashboard: React.FC = () => {
  const { psychologist } = useAuthStore();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow">
        <div className="mx-auto px-4 py-4">
          <h1 className="text-xl font-semibold text-gray-900">
            PsiConnect Dashboard
          </h1>
          <p className="text-sm text-gray-600">
            Bem-vindo, {psychologist?.name}
          </p>
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="grid md:grid-cols-2 gap-6">
          {/* Create session */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4">Agendar Sessão</h2>
            <form className="space-y-4">
              <input
                type="datetime-local"
                placeholder="Data e hora"
                className="w-full border rounded px-3 py-2"
              />
              <input
                type="number"
                placeholder="Duração (minutos)"
                className="w-full border rounded px-3 py-2"
              />
              <button
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded"
              >
                Criar Sessão
              </button>
            </form>
          </div>

          {/* Sessions list */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-lg font-semibold mb-4">Próximas Sessões</h2>
            <div className="space-y-2 text-gray-600">
              <p>Nenhuma sessão agendada</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
