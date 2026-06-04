/**
 * Typed fetch wrapper. All API calls go through `/api/*` which Nginx proxies
 * to the Fastify API (in dev, Next.js rewrites do the same).
 *
 * Cookies carry the session, so we always send credentials.
 */

export interface ApiError extends Error {
  status: number;
  body: unknown;
}

async function send<T>(method: string, path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
    signal: opts?.signal,
  });
  if (!res.ok) {
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* noop */ }
    const err = new Error(`API ${method} ${path} → ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, opts?: { signal?: AbortSignal }) => send<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) => send<T>("POST", path, body, opts),
  put: <T>(path: string, body?: unknown) => send<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => send<T>("PATCH", path, body),
  del: <T>(path: string) => send<T>("DELETE", path),
};

export async function uploadFile<T>(path: string, file: File, fields: Record<string, string | string[]>): Promise<T> {
  const fd = new FormData();
  fd.set("file", file);
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else if (v !== undefined && v !== null) fd.set(k, v);
  }
  const res = await fetch(`/api${path}`, { method: "POST", body: fd, credentials: "include" });
  if (!res.ok) {
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* noop */ }
    const err = new Error(`API POST ${path} → ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return (await res.json()) as T;
}
