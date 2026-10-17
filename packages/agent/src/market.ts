import type { Dec, EpochSec } from "@bekci/shared";

export type Candle = { ts: EpochSec; open: Dec; high: Dec; low: Dec; close: Dec; vol: Dec };
export type MarketView = { instId: string; last: Dec; bid: Dec; ask: Dec; candles: Candle[]; fetchedAt: EpochSec };

/** Read-only market data. The agent has no OKX key (INV-1); only public endpoints are used. */
export interface MarketObserver {
  observe(instId: string): Promise<MarketView>;
}

/**
 * Public OKX REST market data (keyless). The plan names `okx-trade-mcp --modules market --read-only`
 * as the agent-side path; this adapter hits the same public endpoints directly and can be swapped.
 */
export class OkxPublicMarketObserver implements MarketObserver {
  constructor(private base = "https://www.okx.com", private bar = "1m", private limit = 60) {}

  async observe(instId: string): Promise<MarketView> {
    const q = encodeURIComponent(instId);
    const [tk, cd] = await Promise.all([
      this.get(`/api/v5/market/ticker?instId=${q}`),
      this.get(`/api/v5/market/candles?instId=${q}&bar=${this.bar}&limit=${this.limit}`),
    ]);
    const t = (tk as { last: string; bidPx: string; askPx: string }[])[0];
    if (!t) throw new Error("no ticker");
    // OKX returns newest first: [ts(ms), o, h, l, c, vol, ...]
    const candles = (cd as string[][]).map((r) => ({
      ts: Math.floor(Number(r[0]) / 1000), open: r[1]!, high: r[2]!, low: r[3]!, close: r[4]!, vol: r[5]!,
    })).reverse();
    return { instId, last: t.last, bid: t.bidPx, ask: t.askPx, candles, fetchedAt: Math.floor(Date.now() / 1000) };
  }

  private async get(path: string): Promise<unknown[]> {
    const res = await fetch(this.base + path, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { code: string; data: unknown[] };
    if (body.code !== "0") throw new Error(`okx market error ${body.code}`);
    return body.data;
  }
}

/** Deterministic market for demos/tests. */
export class FixtureMarketObserver implements MarketObserver {
  constructor(private closes: number[], private spreadBps = 2) {}
  async observe(instId: string): Promise<MarketView> {
    const now = Math.floor(Date.now() / 1000);
    const candles = this.closes.map((c, i) => ({
      ts: now - (this.closes.length - i) * 60, open: String(c), high: String(c), low: String(c), close: String(c), vol: "10",
    }));
    const last = this.closes[this.closes.length - 1]!;
    const half = (last * this.spreadBps) / 20000;
    return { instId, last: String(last), bid: (last - half).toFixed(2), ask: (last + half).toFixed(2), candles, fetchedAt: now };
  }
}
