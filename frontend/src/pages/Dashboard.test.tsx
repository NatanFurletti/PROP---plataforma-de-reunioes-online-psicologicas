import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const listSessions = vi.fn();
const createSession = vi.fn();
const logout = vi.fn();
const navigate = vi.fn();

vi.mock("../services/api", () => ({
  sessionService: {
    listSessions: () => listSessions(),
    createSession: (data: unknown) => createSession(data),
  },
  authService: {
    logout: () => logout(),
  },
}));

vi.mock("../contexts/useSessionStore", () => ({
  useAuthStore: () => ({
    psychologist: { id: "p1", name: "Dra. Ana", email: "ana@test.com" },
    logout: vi.fn(),
  }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

const { Dashboard } = await import("./Dashboard");

// Data relativa a agora: uma data fixa acabaria expirando e escondendo o link
const SESSION = {
  id: "sess-1",
  scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  durationMinutes: 50,
  status: "SCHEDULED" as const,
  accessToken: "token-abc",
  createdAt: "2026-08-01T10:00:00.000Z",
};

function renderDashboard() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  listSessions.mockReset().mockResolvedValue({ data: [SESSION] });
  createSession.mockReset().mockResolvedValue({ data: { id: "nova" } });
  navigate.mockReset();
});

describe("Dashboard — listagem", () => {
  it("exibe as sessões retornadas pela API", async () => {
    renderDashboard();
    expect(await screen.findByText("Agendada")).toBeInTheDocument();
    expect(screen.getByText(/50 min/i)).toBeInTheDocument();
  });

  it("exibe mensagem de erro quando a busca falha", async () => {
    listSessions.mockRejectedValue(new Error("network"));
    renderDashboard();
    expect(await screen.findByText(/não foi possível carregar/i)).toBeInTheDocument();
  });

  it("exibe estado vazio quando não há sessões", async () => {
    listSessions.mockResolvedValue({ data: [] });
    renderDashboard();
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
    expect(screen.queryByText("Agendada")).not.toBeInTheDocument();
  });
});

describe("Dashboard — copiar link", () => {
  it("copia a URL de convite do paciente", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });

    renderDashboard();
    const button = await screen.findByRole("button", {
      name: /copiar link da sessão/i,
    });
    await userEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // O link deve apontar para a rota publica /join com o accessToken
    expect(writeText.mock.calls[0][0]).toMatch(/\/join\/token-abc$/);

    vi.unstubAllGlobals();
  });

  it("dá feedback visual após copiar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });

    renderDashboard();
    await userEvent.click(
      await screen.findByRole("button", { name: /copiar link da sessão/i }),
    );

    expect(await screen.findByText("Copiado!")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "não oferece o link para sessão %s",
    async (status) => {
      listSessions.mockResolvedValue({ data: [{ ...SESSION, status }] });
      renderDashboard();
      await screen.findByText(status === "COMPLETED" ? "Concluída" : "Cancelada");
      expect(
        screen.queryByRole("button", { name: /copiar link da sessão/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("não oferece o link para sessão expirada", async () => {
    // Agendada há 2h com 50 min de duração: passou da janela de 30 min
    const scheduledAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    listSessions.mockResolvedValue({ data: [{ ...SESSION, scheduledAt }] });
    renderDashboard();
    await screen.findByText("Agendada");
    expect(
      screen.queryByRole("button", { name: /copiar link da sessão/i }),
    ).not.toBeInTheDocument();
  });
});

describe("Dashboard — criar sessão", () => {
  it("envia a nova sessão e recarrega a lista", async () => {
    renderDashboard();
    await screen.findByText("Agendada");

    await userEvent.click(screen.getByRole("button", { name: /nova sessão/i }));

    const future = "2099-12-01T15:00";
    const input = screen.getByLabelText(/data e hora/i);
    await userEvent.clear(input);
    await userEvent.type(input, future);

    listSessions.mockClear();
    const form = screen.getByRole("region", {
      name: /formulário de nova sessão/i,
    });
    await userEvent.click(
      within(form).getByRole("button", { name: /agendar|criar/i }),
    );

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    // A lista deve ser recarregada apos a criacao
    await waitFor(() => expect(listSessions).toHaveBeenCalled());
  });

  it("abre com o horário atual preenchido", async () => {
    renderDashboard();
    await screen.findByText("Agendada");
    await userEvent.click(screen.getByRole("button", { name: /nova sessão/i }));

    const input = screen.getByLabelText(/data e hora/i) as HTMLInputElement;
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const diff = Math.abs(new Date(input.value).getTime() - Date.now());
    expect(diff).toBeLessThan(2 * 60_000);
  });

  it("cria a sessão para agora mesmo se o horário padrão já passou", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 4, 6, 0));
    renderDashboard();
    await screen.findByText("Agendada");
    await userEvent.click(screen.getByRole("button", { name: /nova sessão/i }));

    // O psicólogo deixa o formulário aberto e só envia 10 minutos depois
    vi.setSystemTime(new Date(2026, 10, 4, 6, 10));
    const form = screen.getByRole("region", { name: /formulário de nova sessão/i });
    await userEvent.click(within(form).getByRole("button", { name: /criar/i }));

    await waitFor(() => expect(createSession).toHaveBeenCalled());
    const sent = new Date(createSession.mock.calls[0][0].scheduledAt);
    expect(sent.getTime()).toBeGreaterThanOrEqual(new Date(2026, 10, 4, 6, 10).getTime());
    expect(screen.queryByText(/horário futuro/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("recusa um horário escolhido no passado", async () => {
    renderDashboard();
    await screen.findByText("Agendada");
    await userEvent.click(screen.getByRole("button", { name: /nova sessão/i }));

    const input = screen.getByLabelText(/data e hora/i);
    await userEvent.clear(input);
    await userEvent.type(input, "2020-01-01T10:00");
    const form = screen.getByRole("region", { name: /formulário de nova sessão/i });
    await userEvent.click(within(form).getByRole("button", { name: /criar/i }));

    expect(await screen.findByText(/horário futuro/i)).toBeInTheDocument();
    expect(createSession).not.toHaveBeenCalled();
  });
});
