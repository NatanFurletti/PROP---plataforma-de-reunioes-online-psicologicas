import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { useAuthStore } from "./contexts/useSessionStore";
import { authService } from "./services/api";

vi.mock("./pages/Dashboard", () => ({ Dashboard: () => <p>painel</p> }));

const networkError = () => new AxiosError("timeout", "ECONNABORTED");

describe("App — bootstrap da autenticação", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({
      psychologist: null,
      isAuthenticated: false,
      bootstrapped: false,
      bootstrapFailed: false,
    });
    window.history.pushState({}, "", "/dashboard");
  });

  it("tenta de novo quando o servidor não responde e entra no painel", async () => {
    const me = vi
      .spyOn(authService, "me")
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({
        data: { psychologist: { id: "1", name: "Ana", email: "a@a.com" } },
      } as never);

    render(<App />);

    expect(await screen.findByText("painel")).toBeInTheDocument();
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("mostra erro com botão de tentar novamente em vez de carregar para sempre", async () => {
    const me = vi.spyOn(authService, "me").mockRejectedValue(networkError());

    render(<App />);

    const retry = await screen.findByRole("button", { name: "Tentar novamente" });
    expect(me).toHaveBeenCalledTimes(3);

    me.mockResolvedValueOnce({
      data: { psychologist: { id: "1", name: "Ana", email: "a@a.com" } },
    } as never);
    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByText("painel")).toBeInTheDocument());
  });

  it("sem sessão (401) vai direto para o login, sem novas tentativas", async () => {
    const error = new AxiosError("unauthorized");
    error.response = { status: 401 } as never;
    const me = vi.spyOn(authService, "me").mockRejectedValue(error);

    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(me).toHaveBeenCalledTimes(1);
  });
});
