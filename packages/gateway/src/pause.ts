import { LIMITS, REASON, recoverPauseSigner, schemas, type Hex, type ReasonCode, type SignedPauseCommand } from "@bekci/shared";
import type { AuditLog } from "./audit";
import { tx } from "./db";
import type { Clock } from "./ports";
import type { GatewayStore } from "./store";

export type PauseResult = { ok: true; paused: boolean } | { ok: false; reasonCode: ReasonCode; message: string };

/**
 * L7 PauseGateway (§6.7). An owner-signed pause takes effect locally at once and persists across
 * restarts, without waiting for the chain. Owner identity comes from the cached, hash-verified
 * policy, so pausing still works while the chain is unreachable.
 *
 * Local pause is cleared when the on-chain Paused event arrives (the chain then holds it) or by an
 * owner-signed unpause. A local unpause never overrides an on-chain pause.
 */
export class PauseGateway {
  constructor(private readonly d: { store: GatewayStore; audit: AuditLog; clock: Clock }) {}

  async handle(raw: unknown): Promise<PauseResult> {
    const fail = (message: string, reasonCode: ReasonCode = REASON.INSUFFICIENT_AUTHORIZATION): PauseResult => ({
      ok: false, reasonCode, message,
    });
    const parsed = schemas.signedPauseCommand.safeParse(raw);
    if (!parsed.success) return fail("malformed pause command");
    const cmd = parsed.data as SignedPauseCommand;
    const now = this.d.clock();

    const cached = this.d.store.getPolicy(cmd.policyId);
    if (!cached) return fail("unknown policy", REASON.POLICY_UNVERIFIED);
    const signer = await recoverPauseSigner(cmd);
    if (!signer || signer.toLowerCase() !== cached.policy.binding.owner.toLowerCase()) return fail("not signed by owner");
    if (Math.abs(now - cmd.issuedAt) > LIMITS.clockSkewSec) return fail("stale pause command");

    const applied = tx(this.d.store.db, () => {
      if (!this.d.store.consumeNonce("pause", cmd.nonce, now)) return false;
      this.d.store.setLocalPause(cmd.policyId, cmd.paused);
      this.d.audit.appendSync({
        ts: now, policyId: cmd.policyId, type: "pause",
        payload: { paused: cmd.paused, source: "owner_signed" },
      });
      return true;
    });
    if (!applied) return fail("pause nonce reused");
    const effective = this.d.store.getPolicy(cmd.policyId)!;
    return { ok: true, paused: effective.pausedLocal || effective.pausedChain };
  }

  /** Chain `PausedChanged` event (PolicyChainClient.watchPause). */
  onChainPause(policyId: Hex, paused: boolean): void {
    const now = this.d.clock();
    const cached = this.d.store.getPolicy(policyId);
    if (!cached) return;
    tx(this.d.store.db, () => {
      this.d.store.upsertPolicy({ ...cached, pausedChain: paused, pausedLocal: paused ? false : cached.pausedLocal });
      this.d.audit.appendSync({ ts: now, policyId, type: "pause", payload: { paused, source: "chain" } });
    });
  }

  isPaused(policyId: Hex): boolean {
    const c = this.d.store.getPolicy(policyId);
    return !c || c.pausedChain || c.pausedLocal;
  }
}
