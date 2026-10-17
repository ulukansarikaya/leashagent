import type { AtkCallResult, AtkErrorPayload } from "./types";

/**
 * Write outcome classification. The only safe default is "uncertain": an order that might have
 * reached OKX must never be treated as rejected (that would release its reservation and invite a
 * resend). Only errors that positively establish non-acceptance count as "rejected".
 */
export type WriteOutcome =
  | { kind: "accepted"; ordId: string; raw: unknown }
  | { kind: "rejected"; code: string; msg: string; raw: unknown }
  | { kind: "uncertain"; reason: string; raw: unknown };

/**
 * OKX 50xxx system codes that explicitly do not establish the request's outcome.
 * 50004: "API endpoint request timeout (does not mean that the request was successful or failed,
 * please check the request result)". 50001/50013/50026 are service-side unavailability.
 */
const UNCERTAIN_OKX_CODES = new Set(["50001", "50004", "50013", "50026"]);

/** Error types raised by ATK before any request is sent, or definite OKX rejections. */
const DEFINITE_TYPES = new Set(["ValidationError", "ConfigError", "AuthenticationError", "RateLimitError"]);

export function errorIsDefiniteRejection(e: AtkErrorPayload): boolean {
  if (DEFINITE_TYPES.has(e.type)) return true;
  if (e.type !== "OkxApiError") return false; // NetworkError, InternalError, unknown types
  const code = e.code ?? "";
  if (!/^\d+$/.test(code)) return false;
  if (/^\d{3}$/.test(code)) return false; // bare HTTP status (e.g. 502/504) without an OKX body
  if (UNCERTAIN_OKX_CODES.has(code)) return false;
  return true; // "1" (all operations failed), 51xxx business errors, other 50xxx definite codes
}

type Row = { ordId?: unknown; clOrdId?: unknown; sCode?: unknown; sMsg?: unknown };

/** Classify the result of spot_place_order / spot_cancel_order. */
export function classifyWrite(r: AtkCallResult): WriteOutcome {
  if (!r.ok) {
    const e = r.error;
    return errorIsDefiniteRejection(e)
      ? { kind: "rejected", code: e.code ?? e.type, msg: e.message, raw: e }
      : { kind: "uncertain", reason: `${e.type}${e.code ? ` ${e.code}` : ""}`, raw: e };
  }
  const rows = r.response.data;
  const row = Array.isArray(rows) ? (rows[0] as Row | undefined) : undefined;
  if (!row || typeof row !== "object") return { kind: "uncertain", reason: "empty response data", raw: r.response };
  const sCode = row.sCode === undefined ? "0" : String(row.sCode);
  if (sCode !== "0") {
    // Per-item failure with an OKX business code is a definite rejection; a system code is not.
    const definite = /^\d+$/.test(sCode) && !UNCERTAIN_OKX_CODES.has(sCode);
    return definite
      ? { kind: "rejected", code: sCode, msg: String(row.sMsg ?? ""), raw: r.response }
      : { kind: "uncertain", reason: `sCode ${sCode}`, raw: r.response };
  }
  if (typeof row.ordId !== "string" || row.ordId === "") return { kind: "uncertain", reason: "no ordId", raw: r.response };
  return { kind: "accepted", ordId: row.ordId, raw: r.response };
}
