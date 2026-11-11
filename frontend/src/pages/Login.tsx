import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authService } from "../services/api";
import { useAuthStore } from "../contexts/useSessionStore";
import { ResendVerification } from "../components/ResendVerification";

export const Login: React.FC = () => {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // E-mail com que o login foi recusado por falta de confirmação
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setUnverifiedEmail(null);
    setLoading(true);

    try {
      const response = await authService.login(formData);
      login(response.data.psychologist);
      navigate("/dashboard");
    } catch (err: unknown) {
      const response = (
        err as { response?: { status?: number; data?: { code?: string } } }
      ).response;
      if (response?.data?.code === "EMAIL_NOT_VERIFIED") {
        setUnverifiedEmail(formData.email);
        setError(
          "Confirme seu e-mail antes de entrar. Use o link que enviamos no cadastro.",
        );
      } else if (response?.status === 401) {
        setError("E-mail ou senha incorretos");
      } else if (response?.status === 429) {
        setError("Muitas tentativas. Aguarde alguns minutos e tente de novo.");
      } else {
        setError("Falha ao fazer login");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">Palas</h1>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={formData.email}
            onChange={(e) =>
              setFormData({ ...formData, email: e.target.value })
            }
            className="w-full border border-gray-300 rounded px-3 py-2"
          />
          <input
            type="password"
            placeholder="Senha"
            value={formData.password}
            onChange={(e) =>
              setFormData({ ...formData, password: e.target.value })
            }
            className="w-full border border-gray-300 rounded px-3 py-2"
          />

          {error && (
            <p className="text-red-600 text-sm" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded disabled:opacity-50"
          >
            {loading ? "Carregando..." : "Login"}
          </button>
        </form>

        {unverifiedEmail && (
          <div className="mt-4">
            <ResendVerification initialEmail={unverifiedEmail} />
          </div>
        )}

        <p className="text-center text-sm text-gray-600 mt-4">
          <Link to="/forgot-password" className="text-blue-600 hover:underline">
            Esqueci minha senha
          </Link>
        </p>

        <p className="text-center text-sm text-gray-600 mt-2">
          Não tem conta?{" "}
          <Link to="/register" className="text-blue-600 hover:underline">
            Registre-se
          </Link>
        </p>
      </div>
    </div>
  );
};
