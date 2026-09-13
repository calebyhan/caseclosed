export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number = 10_000,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { text: text.slice(0, 500) }; }
    return { status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

export function remoteError(provider: string, status: number, body: unknown): string {
  const detail = JSON.stringify(body).slice(0, 500);
  return `${provider} returned HTTP ${status}: ${detail}`;
}

export const isTransientStatus = (status: number) => status === 408 || status === 429 || status >= 500;
