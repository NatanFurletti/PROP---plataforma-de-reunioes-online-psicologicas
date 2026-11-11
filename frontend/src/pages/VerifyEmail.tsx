import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { authService } from "../services/api";
import { ResendVerification } from "../components/ResendVerification";

type State = "loading" | "success" | "error";

export const VerifyEmail: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>(token ? "loading" : "error");
  // O token é de uso único: em StrictMode o efeito roda duas vezes e a
  // segunda chamada falharia contra um token já consumido.
  const requested = useRef(false);

  useEffect(() => {
    if (!token || requested.current) return;
    requested.current = true;

    authService
      .verifyEmail(token)
      .then(() => setState("success"))
      .catch(() => setState("error"));
  }, [token]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold mb-6">Palas</h1>

        {state === "loading" && (
          <p className="text-gray-600" role="status">
            Confirmando seu e-mail...
          </p>
        )}

        {state === "success" && (
          <>
            <p className="text-green-700 font-semibold mb-4">
              E-mail confirmado com sucesso.
            </p>
            <Link to="/login" className="text-blue-600 hover:underline">
              Ir para o login
            </Link>
          </>
        )}

        {state === "error" && (
          <>
            <p className="text-red-600 font-semibold mb-2">
              Link inválido ou expirado.
            </p>
            <p className="text-sm text-gray-600 mb-4">
              O link pode já ter sido usado ou ter passado de 24 horas. Se sua
              conta já foi confirmada, basta entrar.
            </p>
            <ResendVerification />
            <p className="mt-4">
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
