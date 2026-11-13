export type SessionStatus = "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface JoinableSession {
  status: SessionStatus;
  scheduledAt: string;
  durationMinutes: number;
}

// Tolerância após o fim previsto — mesma regra de
// SessionService.validateAccessToken no backend (scheduledAt + duração + 30min)
const JOIN_GRACE_MINUTES = 30;

// O link só serve enquanto o backend ainda aceitar o accessToken: sessão
// não encerrada/cancelada e dentro da janela de expiração.
export function isSessionJoinable(session: JoinableSession, now: Date = new Date()): boolean {
  if (session.status === "COMPLETED" || session.status === "CANCELLED") {
    return false;
  }
  const expiresAt = new Date(session.scheduledAt).getTime() +
    (session.durationMinutes + JOIN_GRACE_MINUTES) * 60_000;
  return now.getTime() <= expiresAt;
}

export function buildJoinLink(accessToken: string): string {
  const clientUrl = import.meta.env.VITE_CLIENT_URL || window.location.origin;
  return `${clientUrl}/join/${accessToken}`;
}
