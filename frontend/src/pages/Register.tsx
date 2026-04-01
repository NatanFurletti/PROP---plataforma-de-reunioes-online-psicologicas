import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { authService } from "../services/api";

interface FormData {
  name: string;
  email: string;
  password: string;
  crp: string;
}

interface FormErrors {
  name?: string;
  email?: string;
  password?: string;
}

export const Register: React.FC = () => {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<FormData>({
    name: "",
    email: "",
    password: "",
    crp: "",
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState("");
  const [loading, setLoading] = useState(false);

  const validate = (): boolean => {
    const newErrors: FormErrors = {};

    if (formData.name.trim().length < 3) {
      newErrors.name = "Nome deve ter pelo menos 3 caracteres";
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      newErrors.email = "E-mail inválido";
    }

    if (formData.password.length < 8) {
      newErrors.password = "Senha deve ter pelo menos 8 caracteres";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError("");

    if (!validate()) return;

    setLoading(true);
    try {
      await authService.register({
        name: formData.name.trim(),
        email: formData.email,
        password: formData.password,
        crp: formData.crp || undefined,
      });
      navigate("/login");
    } catch (err: unknown) {
      const axiosErr = err as { response?: { status: number; data?: { error?: string } } };
      if (axiosErr.response?.status === 409) {
        setServerError("Este e-mail já está cadastrado");
      } else if (axiosErr.response?.status === 400) {
        const msg = axiosErr.response.data?.error || "Dados inválidos. Verifique os campos.";
        setServerError(msg);
      } else {
        setServerError("Erro ao criar conta. Tente novamente.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (field: keyof FormData) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [field]: e.target.value });
    if (errors[field as keyof FormErrors]) {
      setErrors({ ...errors, [field]: undefined });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-r from-blue-600 to-blue-800">
      <div className="bg-white rounded-lg shadow-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-bold text-center mb-2">PsiConnect</h1>
        <p className="text-center text-gray-500 text-sm mb-6">Crie sua conta</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <input
              type="text"
              placeholder="Nome completo"
              value={formData.name}
              onChange={handleChange("name")}
              className="w-full border border-gray-300 rounded px-3 py-2"
              aria-label="Nome completo"
            />
            {errors.name && <p className="text-red-600 text-xs mt-1">{errors.name}</p>}
          </div>

          <div>
            <input
              type="email"
              placeholder="E-mail"
              value={formData.email}
              onChange={handleChange("email")}
              className="w-full border border-gray-300 rounded px-3 py-2"
              aria-label="E-mail"
            />
            {errors.email && <p className="text-red-600 text-xs mt-1">{errors.email}</p>}
          </div>

          <div>
            <input
              type="password"
              placeholder="Senha (mínimo 8 caracteres)"
              value={formData.password}
              onChange={handleChange("password")}
              className="w-full border border-gray-300 rounded px-3 py-2"
              aria-label="Senha"
            />
            {errors.password && <p className="text-red-600 text-xs mt-1">{errors.password}</p>}
          </div>

          <div>
            <input
              type="text"
              placeholder="CRP (opcional)"
              value={formData.crp}
              onChange={handleChange("crp")}
              className="w-full border border-gray-300 rounded px-3 py-2"
              aria-label="CRP (opcional)"
            />
          </div>

          {serverError && <p className="text-red-600 text-sm">{serverError}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 rounded disabled:opacity-50"
          >
            {loading ? "Criando conta..." : "Criar conta"}
          </button>
        </form>

        <p className="text-center text-sm text-gray-600 mt-4">
          Já tem conta?{" "}
          <a href="/login" className="text-blue-600 hover:underline">
            Entrar
          </a>
        </p>
      </div>
    </div>
  );
};
