// Identidade do paciente numa sessão, guardada neste navegador.
//
// Com ela, o paciente que volta pelo mesmo link (nova aba, fechou o
// navegador, caiu) não digita o nome de novo e, se já foi aprovado, entra
// direto. O servidor reconhece a pessoa pela `admissionKey` e mantém o nome
// do primeiro pedido — não dá para entrar de novo com outro nome.
//
// Não é credencial de login: a chave só vale para esta sessão e enquanto a
// sala existir. Fica no localStorage para sobreviver ao fechamento da aba.

export interface GuestIdentity {
  name: string;
  accessToken: string;
  admissionKey?: string;
}

const PREFIX = "psiconnect:guest:";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Navegação privada / armazenamento bloqueado
    return null;
  }
}

export function loadGuestIdentity(sessionId: string): GuestIdentity | null {
  try {
    const raw = storage()?.getItem(PREFIX + sessionId);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<GuestIdentity>;
    if (typeof data.name !== "string" || typeof data.accessToken !== "string") {
      return null;
    }
    return {
      name: data.name,
      accessToken: data.accessToken,
      admissionKey: typeof data.admissionKey === "string" ? data.admissionKey : undefined,
    };
  } catch {
    return null;
  }
}

export function saveGuestIdentity(sessionId: string, identity: GuestIdentity): void {
  try {
    storage()?.setItem(PREFIX + sessionId, JSON.stringify(identity));
  } catch {
    // Sem armazenamento: só perde o reconhecimento automático
  }
}

export function updateGuestIdentity(
  sessionId: string,
  patch: Partial<GuestIdentity>,
): void {
  const current = loadGuestIdentity(sessionId);
  if (current) saveGuestIdentity(sessionId, { ...current, ...patch });
}

export function clearGuestIdentity(sessionId: string): void {
  try {
    storage()?.removeItem(PREFIX + sessionId);
  } catch {
    // ignora
  }
}
