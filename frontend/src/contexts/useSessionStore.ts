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
