const TOKEN_KEY = "alo_cabinet_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

const BASE = import.meta.env.VITE_API_URL || "/api";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = ct.includes("json") ? await res.json() : await res.text();
    } catch {
      body = null;
    }
    const msg =
      typeof body === "object" && body && "message" in body
        ? String((body as { message: string }).message)
        : `Ошибка ${res.status}`;
    throw new ApiError(res.status, body, msg);
  }
  if (res.status === 204) return undefined as T;
  if (ct.includes("json")) return (await res.json()) as T;
  return (await res.arrayBuffer()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  download: async (path: string, filename: string) => {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const res = await fetch(`${BASE}${path}`, { headers });
    if (!res.ok) throw new ApiError(res.status, null, "Не удалось скачать файл");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
