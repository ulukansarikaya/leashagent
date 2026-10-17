import type { Dec, EpochSec, ExecutionEvent, Hex, NormalizedOrder, Tool } from "@bekci/shared";

/** Result of an ATK write. A thrown error means the outcome is uncertain (timeout / network). */
export type AtkResult =
  | { ok: true; ordId: string; raw: unknown }
  | { ok: false; kind: "rejected"; code: string; msg: string; raw: unknown };

export type AtkOrderState = "live" | "partially_filled" | "filled" | "canceled";

export type AtkOrder = {
  ordId: string;
  clOrdId: string;
  instId: string;
  state: AtkOrderState;
  accFillSz: Dec;
  raw: unknown;
};

/**
 * Wraps ATK (CLI or MCP) with the trade-enabled key (§17). Upper layers do not know the transport.
 * Unverified: confirmation-prompt behaviour, tgtCcy semantics, clOrdId constraints (P0 spike).
 */
export interface AtkClient {
  placeSpotOrder(o: NormalizedOrder): Promise<AtkResult>;
  cancelSpotOrder(o: NormalizedOrder): Promise<AtkResult>;
  getOrderByClOrdId(instId: string, clOrdId: string): Promise<AtkOrder | null>;
}

/** Executor-side policy recheck through an authenticated chain/read adapter (§6.6 step 5, §15.2). */
export interface PolicyStateProvider {
  getExecutionState(policyId: Hex): Promise<{
    policyVersion: number;
    accountRef: Hex;
    agentRegistry: Hex;
    agentRegistryId: string;
    agentAuthAddress: Hex;
    delegationValidUntil: EpochSec;
    revoked: boolean;
    paused: boolean;
  }>;
}

/** Receives execution events for L5 (reservations) and L7 (audit/chain). Failures are not fatal. */
export interface ExecutionSink {
  onEvent(e: ExecutionEvent, ctx: { policyId: Hex }): Promise<void> | void;
}

export type ExecutorConfig = {
  /** GUARD_SIGNER_ADDRESS: the only accepted authorization signer. */
  guardSignerAddress: Hex;
  /** GUARD_INSTANCE_ID */
  guardInstanceId: string;
  /** keccak256 of the OKX account this executor's trade key belongs to. */
  accountRef: Hex;
  allowedTools: Tool[];
  clockSkewSec: number;
};

export type Clock = () => EpochSec;
