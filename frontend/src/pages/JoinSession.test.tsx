import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { loadGuestIdentity, saveGuestIdentity } from "../utils/guestIdentity";

const validateSessionToken = vi.fn();
const navigate = vi.fn();

vi.mock("../services/api", () => ({
  sessionService: {
    validateSessionToken: (t: string) => validateSessionToken(t),
  },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigate };
});

const { JoinSession } = await import("./JoinSession");

const SESSION = {
  sessionId: "s1",
  scheduledAt: "2026-11-03T15:00:00.000Z",
  durationMinutes: 50,
  psychologistName: "Dra. Ana",
};

function renderJoin(token = "tok") {
  return render(
    <MemoryRouter initialEntries={[`/join/${token}`]}>
      <Routes>
        <Route path="/join/:token" element={<JoinSession />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  navigate.mockReset();
  validateSessionToken.mockReset().mockResolvedValue({ data: SESSION });
});

describe("JoinSession — paciente voltando pelo link", () => {
  it("primeira visita pede o nome e guarda neste navegador", async () => {
    renderJoin();
    await userEvent.type(await screen.findByLabelText("Seu nome completo"), "Maria");
    await userEvent.click(screen.getByRole("button", { name: "Entrar na sessão" }));

    expect(loadGuestIdentity("s1")).toEqual({ name: "Maria", accessToken: "tok" });
    expect(navigate).toHaveBeenCalledWith("/call/s1?role=guest");
  });

  it("quem já entrou por este link vai direto para a chamada, sem digitar o nome", async () => {
    saveGuestIdentity("s1", { name: "Maria", accessToken: "tok", admissionKey: "k1" });
    renderJoin();

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/call/s1?role=guest", { replace: true }),
    );
    expect(screen.queryByLabelText("Seu nome completo")).toBeNull();
  });

  it("identidade de outro link não é reaproveitada", async () => {
    saveGuestIdentity("s1", { name: "Maria", accessToken: "outro-token" });
    renderJoin();

    expect(await screen.findByLabelText("Seu nome completo")).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});
