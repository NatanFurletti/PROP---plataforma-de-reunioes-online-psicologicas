import axios from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3333";

const api = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true,
});

// Interceptor: 401 em rotas autenticadas → emitir evento global para o store reagir
// (não redireciona aqui para evitar acoplar axios ao react-router)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status;
    const url: string = error?.config?.url ?? "";
    // Ignorar 401 do próprio /auth/me (bootstrap silencioso) e do /auth/login
    const isAuthEndpoint = url.includes("/auth/login") || url.includes("/auth/me");
    if (status === 401 && !isAuthEndpoint) {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    }
    return Promise.reject(error);
  },
);

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
  me: () => api.get("/auth/me"),
  verifyEmail: (token: string) => api.get(`/auth/verify-email/${token}`),
  forgotPassword: (email: string) =>
    api.post("/auth/forgot-password", { email }),
  resetPassword: (token: string, password: string) =>
    api.post("/auth/reset-password", { token, password }),
};

export const sessionService = {
  createSession: (data: { scheduledAt: string; durationMinutes: number }) =>
    api.post("/sessions", data),
  listSessions: () => api.get("/sessions"),
  getSession: (id: string) => api.get(`/sessions/${id}`),
  updateSessionStatus: (id: string, status: string) =>
    api.patch(`/sessions/${id}/status`, { status }),
  cancelSession: (id: string) =>
    api.patch(`/sessions/${id}/status`, { status: "CANCELLED" }),
  rescheduleSession: (
    id: string,
    data: { scheduledAt: string; durationMinutes?: number },
  ) => api.patch(`/sessions/${id}/reschedule`, data),
  validateSessionToken: (token: string) => api.get(`/sessions/join/${token}`),
};

export default api;
