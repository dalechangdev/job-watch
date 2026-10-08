const USER_AGENT = "job-watch/1.0 (personal job alerts; low volume)";
const TIMEOUT_MS = 20_000;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/** fetch with a timeout, a polite user agent, and one retry on 429/5xx. */
export async function http(url: string, init: RequestInit = {}, retries = 1): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": USER_AGENT, accept: "*/*", ...(init.headers ?? {}) },
  });
  if ((res.status === 429 || res.status >= 500) && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 3000;
    await sleep(waitMs);
    return http(url, init, retries - 1);
  }
  return res;
}

export async function getJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await http(url, { ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export async function getText(url: string, init: RequestInit = {}): Promise<string> {
  const res = await http(url, init);
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function pMap<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  middot: "·",
  hellip: "…",
  "#39": "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower] as string;
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return m;
  });
}

/** Crude HTML → text, good enough for feeding a model. Handles entity-escaped HTML (Greenhouse). */
export function htmlToText(html: string | undefined | null): string {
  if (!html) return "";
  let s = html;
  if (/&lt;\w/.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .replace(/[ \t\f\r]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim();
}

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function today(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
