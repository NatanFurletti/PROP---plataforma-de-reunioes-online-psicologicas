import { create } from "zustand";

interface Psychologist {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  psychologist: Psychologist | null;
  isAuthenticated: boolean;
  // bootstrapped indica se a verificação inicial via /auth/me já terminou
  bootstrapped: boolean;
  login: (psychologist: Psychologist) => void;
  logout: () => void;
  setBootstrapped: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  psychologist: null,
  isAuthenticated: false,
  bootstrapped: false,
  login: (psychologist) => set({ psychologist, isAuthenticated: true }),
  logout: () => set({ psychologist: null, isAuthenticated: false }),
  setBootstrapped: (value) => set({ bootstrapped: value }),
}));

interface SessionState {
  sessionId: string | null;
  role: "host" | "guest" | null;
  status: "waiting" | "active" | "ended";
  patientName: string | null;
  accessToken: string | null;
  setSessionId: (id: string) => void;
  setRole: (role: "host" | "guest") => void;
  setStatus: (status: "waiting" | "active" | "ended") => void;
  setPatientInfo: (name: string, token: string) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  role: null,
  status: "waiting",
  patientName: null,
  accessToken: null,
  setSessionId: (id) => set({ sessionId: id }),
  setRole: (role) => set({ role }),
  setStatus: (status) => set({ status }),
  setPatientInfo: (name, token) => set({ patientName: name, accessToken: token }),
  clearSession: () => set({ sessionId: null, role: null, status: "ended", patientName: null, accessToken: null }),
}));
