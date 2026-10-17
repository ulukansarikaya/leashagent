import type { InstrumentInfo } from "@leashagent/shared";

export const BTC_USDT: InstrumentInfo = { instId: "BTC-USDT", lotSz: "0.00000001", tickSz: "0.1", minSz: "0.00001" };

/** Static instrument table standing in for ATK `market` instrument info. */
export class StaticInstruments {
  private readonly map: Map<string, InstrumentInfo>;
  failing = false;

  constructor(list: InstrumentInfo[] = [BTC_USDT]) {
    this.map = new Map(list.map((i) => [i.instId, i]));
  }

  async getInstrument(instId: string): Promise<InstrumentInfo | null> {
    if (this.failing) throw new Error("market data unavailable");
    return this.map.get(instId) ?? null;
  }
}
