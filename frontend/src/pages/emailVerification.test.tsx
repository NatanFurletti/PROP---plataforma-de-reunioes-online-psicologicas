import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const login = vi.fn();
const register = vi.fn();
const resendVerification = vi.fn();
const navigate = vi.fn();
const storeLogin = vi.fn();

vi.mock("../services/api", () => ({
  authService: {
    login: (d: unknown) => login(d),
    register: (d: unknown) => register(d),
    resendVerification: (e: string) => resendVerification(e),
  },
}));

vi.mock("../contexts/useSessionStore", () => ({
  useAuthStore: () => ({ login: storeLogin }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

const { Login } = await import("./Login");
const { Register } = await import("./Register");

beforeEach(() => {
  login.mockReset();
  register.mockReset().mockResolvedValue({ data: { id: "p1" } });
  resendVerification.mockReset().mockResolvedValue({ data: {} });
  navigate.mockReset();
  storeLogin.mockReset();
});

const renderPage = (el: React.ReactNode) =>
  render(<MemoryRouter>{el}</MemoryRouter>);

describe("Login com e-mail não confirmado", () => {
  it("avisa e permite reenviar o link para o e-mail digitado", async () => {
    login.mockRejectedValue({
      response: { status: 403, data: { code: "EMAIL_NOT_VERIFIED" } },
    });
    const user = userEvent.setup();
    renderPage(<Login />);

    await user.type(screen.getByPlaceholderText("Email"), "ana@test.com");
    await user.type(screen.getByPlaceholderText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /confirme seu e-mail/i,
    );
    expect(navigate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Reenviar link" }));
    await waitFor(() =>
      expect(resendVerification).toHaveBeenCalledWith("ana@test.com"),
    );
    expect(await screen.findByText(/enviamos um novo link/i)).toBeInTheDocument();
  });

  it("mostra credenciais incorretas sem oferecer reenvio", async () => {
    login.mockRejectedValue({ response: { status: 401, data: {} } });
    const user = userEvent.setup();
    renderPage(<Login />);

    await user.type(screen.getByPlaceholderText("Email"), "ana@test.com");
    await user.type(screen.getByPlaceholderText("Senha"), "errada123");
    await user.click(screen.getByRole("button", { name: "Login" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /e-mail ou senha incorretos/i,
    );
    expect(
      screen.queryByRole("button", { name: "Reenviar link" }),
    ).not.toBeInTheDocument();
  });
});

describe("Cadastro", () => {
  it("pede para confirmar o e-mail em vez de ir para o login", async () => {
    const user = userEvent.setup();
    renderPage(<Register />);

    await user.type(screen.getByLabelText("Nome completo"), "Ana Silva");
    await user.type(screen.getByLabelText("E-mail"), "ana@test.com");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));

    expect(await screen.findByText(/confirme seu e-mail/i)).toBeInTheDocument();
    expect(screen.getByText("ana@test.com")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("Reenvio do link", () => {
  it("avisa quando o limite de tentativas foi atingido", async () => {
    login.mockRejectedValue({
      response: { status: 403, data: { code: "EMAIL_NOT_VERIFIED" } },
    });
    resendVerification.mockRejectedValue({ response: { status: 429 } });
    const user = userEvent.setup();
    renderPage(<Login />);

    await user.type(screen.getByPlaceholderText("Email"), "ana@test.com");
    await user.type(screen.getByPlaceholderText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Login" }));
    await user.click(
      await screen.findByRole("button", { name: "Reenviar link" }),
    );

    expect(await screen.findByText(/muitas tentativas/i)).toBeInTheDocument();
  });
});
