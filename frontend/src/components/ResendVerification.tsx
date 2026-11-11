import React, { useState } from "react";
import { authService } from "../services/api";

interface ResendVerificationProps {
  initialEmail?: string;
}

type Status = "idle" | "sending" | "sent" | "error" | "rate-limited";

// Pede um novo link de confirmação de e-mail. A resposta do servidor é a
// mesma exista ou não a conta, então a mensagem de sucesso é neutra.
export const ResendVerification = ({
  initialEmail = "",
}: ResendVerificationProps) => {
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState<Status>("idle");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus("sending");
    try {
      await authService.resendVerification(email.trim());
      setStatus("sent");
    } catch (err: unknown) {
      const httpStatus = (err as { response?: { status?: number } }).response
        ?.status;
      setStatus(httpStatus === 429 ? "rate-limited" : "error");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-2 text-left">
      <label
        htmlFor="resend-verification-email"
        className="block text-sm text-gray-700"
      >
        Reenviar link de confirmação para:
      </label>
      <input
        id="resend-verification-email"
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (status !== "sending") setStatus("idle");
        }}
        className="w-full border border-gray-300 rounded px-3 py-2"
        required
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full border border-blue-600 text-blue-700 hover:bg-blue-50 font-semibold py-2 rounded disabled:opacity-50"
      >
        {status === "sending" ? "Enviando..." : "Reenviar link"}
      </button>
      <p role="status" aria-live="polite" className="text-sm">
        {status === "sent" && (
          <span className="text-green-700">
            Se esta conta ainda precisar de confirmação, enviamos um novo link.
            Confira também a caixa de spam.
          </span>
        )}
        {status === "rate-limited" && (
          <span className="text-red-600">
            Muitas tentativas. Aguarde alguns minutos e tente de novo.
          </span>
        )}
        {status === "error" && (
          <span className="text-red-600">
            Não foi possível reenviar agora. Tente novamente.
          </span>
        )}
      </p>
    </form>
  );
};
