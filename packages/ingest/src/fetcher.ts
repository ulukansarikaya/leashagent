import type { EpochSec } from "@leashagent/shared";

/** RawContent never leaves L1 (§6.1). */
export type RawContent = { url?: string; fetchedAt: EpochSec; body: string };

export interface ContentSource {
  /** Returns raw items for a query. Implementations enforce their own allowlist. */
  fetch(source: "news" | "web" | "social", query: string): Promise<RawContent[]>;
}

export type HttpFetcherConfig = {
  allowedHosts: string[];
  /** Maps (source, query) → candidate URLs; e.g. an RSS/news search endpoint. */
  resolve: (source: "news" | "web" | "social", query: string) => string[];
  timeoutMs?: number;
  maxBytes?: number;
};

const ALLOWED_TYPES = ["text/html", "text/plain", "application/json", "application/rss+xml", "application/xml", "text/xml"];

export class HttpFetcher implements ContentSource {
  constructor(private cfg: HttpFetcherConfig) {}

  async fetch(source: "news" | "web" | "social", query: string): Promise<RawContent[]> {
    const out: RawContent[] = [];
    for (const url of this.cfg.resolve(source, query).slice(0, 5)) {
      const u = new URL(url);
      if (u.protocol !== "https:" || !this.cfg.allowedHosts.includes(u.hostname)) continue;
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 5000), redirect: "error" });
        const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
        if (!res.ok || !ALLOWED_TYPES.includes(type)) continue;
        out.push({ url: u.toString(), fetchedAt: Math.floor(Date.now() / 1000), body: await readCapped(res, this.cfg.maxBytes ?? 256_000) });
      } catch {
        // a failed source is skipped, never retried blindly
      }
    }
    return out;
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

/** Offline source for demos/tests: fixed documents keyed by source. */
export class FixtureSource implements ContentSource {
  constructor(private docs: { source: "news" | "web" | "social"; url?: string; body: string }[]) {}
  async fetch(source: "news" | "web" | "social"): Promise<RawContent[]> {
    const now = Math.floor(Date.now() / 1000);
    return this.docs.filter((d) => d.source === source).map((d) => ({ url: d.url, fetchedAt: now, body: d.body }));
  }
}
