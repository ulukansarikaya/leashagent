import { isDec, type Dec, type EpochSec, type InstrumentInfo } from "@bekci/shared";

// Structurally matches @bekci/gateway MarketDataProvider / Ticker.

export const OKX_SITES: Record<string, string> = {
  global: "https://www.okx.com",
  eea: "https://eea.okx.com",
  us: "https://us.okx.com",
  tr: "https://tr.okx.com",
};

export type PublicMarketOptions = {
  site: string;
  /** Simulated trading: demo has its own order book, so prices must come from it too. */
  demo: boolean;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Instruments are cached; lot/tick sizes change rarely. */
  instrumentTtlSec?: number;
  clock?: () => EpochSec;
};

/**
 * Keyless market data from OKX public REST (`/api/v5/market/ticker`, `/api/v5/public/instruments`).
 * ATK's `market` module wraps the same endpoints, but has no MCP tool for instrument metadata,
 * so this adapter calls them directly. No credentials are involved.
 */
export class OkxPublicMarketData {
  private readonly base: string;
  private readonly cache = new Map<string, { info: InstrumentInfo | null; at: EpochSec }>();

  constructor(private readonly o: PublicMarketOptions) {
    const b = o.baseUrl ?? OKX_SITES[o.site];
    if (!b) throw new Error(`unknown OKX site ${o.site}`);
    this.base = b.replace(/\/+$/, "");
  }

  private now(): EpochSec {
    return (this.o.clock ?? (() => Math.floor(Date.now() / 1000)))();
  }

  private async get(path: string): Promise<Record<string, unknown>[]> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.o.demo) headers["x-simulated-trading"] = "1";
    const res = await (this.o.fetchImpl ?? fetch)(this.base + path, {
      headers,
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 5_000),
    });
    const body = (await res.json()) as { code?: string; msg?: string; data?: unknown };
    if (!res.ok || body.code !== "0" || !Array.isArray(body.data)) {
      throw new Error(`OKX public ${path} failed: ${res.status} ${body.code ?? ""} ${body.msg ?? ""}`.trim());
    }
    return body.data as Record<string, unknown>[];
  }

  async getInstrument(instId: string): Promise<InstrumentInfo | null> {
    const hit = this.cache.get(instId);
    if (hit && this.now() - hit.at <= (this.o.instrumentTtlSec ?? 3600)) return hit.info;
    const rows = await this.get(`/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(instId)}`);
    const r = rows[0];
    let info: InstrumentInfo | null = null;
    if (r && r.state === "live" && isDec(String(r.lotSz)) && isDec(String(r.tickSz))) {
      info = { instId, lotSz: String(r.lotSz), tickSz: String(r.tickSz) };
      if (isDec(String(r.minSz))) info.minSz = String(r.minSz);
    }
    this.cache.set(instId, { info, at: this.now() });
    return info;
  }

  async getTicker(instId: string): Promise<{ instId: string; bid: Dec; ask: Dec; last: Dec; ts: EpochSec }> {
    const rows = await this.get(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const r = rows[0];
    const bid = String(r?.bidPx ?? "");
    const ask = String(r?.askPx ?? "");
    const last = String(r?.last ?? "");
    const tsMs = Number(r?.ts);
    if (!isDec(bid) || !isDec(ask) || !isDec(last) || !Number.isFinite(tsMs)) throw new Error(`malformed ticker for ${instId}`);
    return { instId, bid, ask, last, ts: Math.floor(tsMs / 1000) };
  }
}
