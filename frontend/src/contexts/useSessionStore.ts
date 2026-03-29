import { create } from "zustand";

interface AuthState {
  psychologist: { id: string; email: string; name: string } | null;
  isAuthenticated: boolean;
  login: (psychologist: any) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  psychologist: null,
  isAuthenticated: false,
  login: (psychologist) => set({ psychologist, isAuthenticated: true }),
  logout: () => set({ psychologist: null, isAuthenticated: false }),
}));

interface SessionState {
  sessionId: string | null;
  role: "host" | "guest" | null;
  status: "waiting" | "active" | "ended";
  setSessionId: (id: string) => void;
  setRole: (role: "host" | "guest") => void;
  setStatus: (status: "waiting" | "active" | "ended") => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  role: null,
  status: "waiting",
  setSessionId: (id) => set({ sessionId: id }),
  setRole: (role) => set({ role }),
  setStatus: (status) => set({ status }),
  clearSession: () => set({ sessionId: null, role: null, status: "ended" }),
}));
