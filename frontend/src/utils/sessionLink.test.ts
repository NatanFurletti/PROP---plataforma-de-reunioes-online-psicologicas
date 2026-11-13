import { describe, expect, it } from "vitest";
import { buildJoinLink, isSessionJoinable } from "./sessionLink";

const NOW = new Date("2026-11-13T12:00:00.000Z");

describe("isSessionJoinable", () => {
  const base = { durationMinutes: 50, scheduledAt: "2026-11-13T12:00:00.000Z" };

  it("aceita sessão agendada no futuro", () => {
    expect(
      isSessionJoinable({ ...base, status: "SCHEDULED", scheduledAt: "2026-11-20T12:00:00.000Z" }, NOW),
    ).toBe(true);
  });

  it("aceita sessão em andamento dentro da janela", () => {
    expect(isSessionJoinable({ ...base, status: "IN_PROGRESS" }, NOW)).toBe(true);
  });

  it.each(["COMPLETED", "CANCELLED"] as const)("rejeita sessão %s", (status) => {
    expect(isSessionJoinable({ ...base, status }, NOW)).toBe(false);
  });

  it("aceita até scheduledAt + duração + 30 min e rejeita depois", () => {
    const session = { ...base, status: "SCHEDULED" as const };
    const limit = new Date(NOW.getTime() + 80 * 60_000);
    expect(isSessionJoinable(session, limit)).toBe(true);
    expect(isSessionJoinable(session, new Date(limit.getTime() + 1))).toBe(false);
  });
});

describe("buildJoinLink", () => {
  it("aponta para a rota pública /join", () => {
    expect(buildJoinLink("abc")).toMatch(/\/join\/abc$/);
  });
});
