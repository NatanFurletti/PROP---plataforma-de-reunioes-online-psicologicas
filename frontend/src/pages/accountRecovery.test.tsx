import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const verifyEmail = vi.fn();
const forgotPassword = vi.fn();
const resetPassword = vi.fn();
const navigate = vi.fn();

vi.mock("../services/api", () => ({
  authService: {
    verifyEmail: (t: string) => verifyEmail(t),
    forgotPassword: (e: string) => forgotPassword(e),
    resetPassword: (t: string, p: string) => resetPassword(t, p),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

const { VerifyEmail } = await import("./VerifyEmail");
const { ForgotPassword } = await import("./ForgotPassword");
const { ResetPassword } = await import("./ResetPassword");

beforeEach(() => {
  verifyEmail.mockReset().mockResolvedValue({ data: { verified: true } });
  forgotPassword.mockReset().mockResolvedValue({ data: {} });
  resetPassword.mockReset().mockResolvedValue({ data: {} });
  navigate.mockReset();
});

function renderAt(path: string, route: string, element: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("VerifyEmail", () => {
  it("confirma o e-mail com o token da URL", async () => {
    renderAt("/verify-email/tok-123", "/verify-email/:token", <VerifyEmail />);

    await waitFor(() => expect(verifyEmail).toHaveBeenCalledWith("tok-123"));
    expect(await screen.findByText(/confirmado com sucesso/i)).toBeInTheDocument();
  });

  it("exibe erro para token inválido", async () => {
    verifyEmail.mockRejectedValue(new Error("400"));
    renderAt("/verify-email/ruim", "/verify-email/:token", <VerifyEmail />);

    expect(await screen.findByText(/inválido ou expirado/i)).toBeInTheDocument();
  });

  it("não repete a chamada em re-render (token é de uso único)", async () => {
    const { rerender } = renderAt(
      "/verify-email/tok-123",
      "/verify-email/:token",
      <VerifyEmail />,
    );
    await waitFor(() => expect(verifyEmail).toHaveBeenCalled());

    rerender(
      <MemoryRouter initialEntries={["/verify-email/tok-123"]}>
        <Routes>
          <Route path="/verify-email/:token" element={<VerifyEmail />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(verifyEmail).toHaveBeenCalledTimes(1);
  });
});

describe("ForgotPassword", () => {
  it("envia o pedido de redefinição", async () => {
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText(/e-mail/i), "ana@test.com");
    await userEvent.click(screen.getByRole("button", { name: /enviar link/i }));

    await waitFor(() =>
      expect(forgotPassword).toHaveBeenCalledWith("ana@test.com"),
    );
  });

  it("mostra a mesma confirmação mesmo se a requisição falhar", async () => {
    forgotPassword.mockRejectedValue(new Error("network"));
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>,
    );

    await userEvent.type(screen.getByLabelText(/e-mail/i), "nao@existe.com");
    await userEvent.click(screen.getByRole("button", { name: /enviar link/i }));

    // A UI nao pode revelar se a conta existe
    expect(await screen.findByText(/se existir uma conta/i)).toBeInTheDocument();
  });
});

describe("ResetPassword", () => {
  async function fill(password: string, confirmation: string) {
    await userEvent.type(screen.getByLabelText(/^nova senha$/i), password);
    await userEvent.type(screen.getByLabelText(/confirme/i), confirmation);
    await userEvent.click(
      screen.getByRole("button", { name: /redefinir senha/i }),
    );
  }

  it("envia token e nova senha", async () => {
    renderAt("/reset-password/tok-9", "/reset-password/:token", <ResetPassword />);
    await fill("senha-nova-123", "senha-nova-123");

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith("tok-9", "senha-nova-123"),
    );
  });

  it("rejeita senhas que não coincidem, sem chamar a API", async () => {
    renderAt("/reset-password/tok-9", "/reset-password/:token", <ResetPassword />);
    await fill("senha-nova-123", "outra-senha-456");

    expect(await screen.findByRole("alert")).toHaveTextContent(/não coincidem/i);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejeita senha curta, sem chamar a API", async () => {
    renderAt("/reset-password/tok-9", "/reset-password/:token", <ResetPassword />);
    await fill("curta", "curta");

    expect(await screen.findByRole("alert")).toHaveTextContent(/8 caracteres/i);
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("exibe erro quando o token é rejeitado pelo backend", async () => {
    resetPassword.mockRejectedValue(new Error("400"));
    renderAt("/reset-password/velho", "/reset-password/:token", <ResetPassword />);
    await fill("senha-nova-123", "senha-nova-123");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /inválido ou expirado/i,
    );
  });
});
