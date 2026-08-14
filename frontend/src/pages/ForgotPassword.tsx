import React, { useState } from "react";
import { Link } from "react-router-dom";
import { authService } from "../services/api";

export const ForgotPassword: React.FC = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await authService.forgotPassword(email);
    } catch {
      // O backend responde igual para conta existente ou não; um erro de
      // rede também não deve revelar nada, então a tela é sempre a mesma.
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-6">PsiConnect</h1>

        {submitted ? (
          <div className="text-center">
            <p className="text-gray-700 mb-4" role="status">
              Se existir uma conta com esse e-mail, enviamos um link para
              redefinir a senha. O link expira em 1 hora.
            </p>
            <Link to="/login" className="text-blue-600 hover:underline">
              Voltar ao login
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 mb-4">
              Informe seu e-mail e enviaremos um link para redefinir a senha.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                  E-mail
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded disabled:opacity-50"
              >
                {loading ? "Enviando..." : "Enviar link"}
              </button>
            </form>

            <p className="text-center text-sm text-gray-600 mt-4">
              <Link to="/login" className="text-blue-600 hover:underline">
                Voltar ao login
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
};
