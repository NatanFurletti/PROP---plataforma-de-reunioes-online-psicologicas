import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3333";

const api = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true,
});

export const authService = {
  register: (data: {
    name: string;
    email: string;
    password: string;
    crp?: string;
  }) => api.post("/auth/register", data),
  login: (data: { email: string; password: string }) =>
    api.post("/auth/login", data),
  logout: () => api.post("/auth/logout"),
};

export const sessionService = {
  createSession: (data: { scheduledAt: string; durationMinutes: number }) =>
    api.post("/sessions", data),
  listSessions: () => api.get("/sessions"),
  getSession: (id: string) => api.get(`/sessions/${id}`),
  updateSessionStatus: (id: string, status: string) =>
    api.patch(`/sessions/${id}/status`, { status }),
  validateSessionToken: (token: string) => api.get(`/sessions/join/${token}`),
};

export default api;
