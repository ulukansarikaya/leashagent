import { bytesToHex, type LocalAccount } from "viem";
import {
  signAuthorization,
  type Decision,
  type ExecutionAuthorization,
  type Hex,
  type ValidatedIntent,
} from "@bekci/shared";
import type { Clock } from "./ports";

export type AuthorizationContext = {
  accountRef: Hex;
  ttlSec: number;
  basis: ExecutionAuthorization["basis"];
};

/** §15.1 Authorizer, with the context it needs (account binding, TTL, basis) made explicit. */
export interface Authorizer {
  sign(d: Decision, v: ValidatedIntent, ctx: AuthorizationContext): Promise<ExecutionAuthorization>;
  readonly signerAddress: Hex;
}

/**
 * Signs order-bound, single-use EIP-712 ExecutionAuthorizations with GUARD_SIGNING_KEY (§5.9).
 * Refuses to sign anything that is not an ALLOW decision for exactly this order.
 */
export class LocalAuthorizer implements Authorizer {
  constructor(
    private readonly account: LocalAccount,
    private readonly guardInstanceId: string,
    private readonly clock: Clock,
  ) {}

  get signerAddress(): Hex {
    return this.account.address;
  }

  async sign(d: Decision, v: ValidatedIntent, ctx: AuthorizationContext): Promise<ExecutionAuthorization> {
    if (d.kind !== "ALLOW") throw new Error("authorization requires an ALLOW decision");
    if (d.requestId !== v.request.requestId || d.policyId !== v.request.policyId) {
      throw new Error("decision does not match intent");
    }
    const issuedAt = this.clock();
    const unsigned: Omit<ExecutionAuthorization, "signature"> = {
      requestId: v.request.requestId,
      policyId: v.request.policyId,
      policyVersion: d.policyVersion,
      accountRef: ctx.accountRef,
      agentId: v.request.agentId,
      tool: v.order.tool,
      normalizedOrderHash: v.normalizedOrderHash,
      nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
      issuedAt,
      expiresAt: issuedAt + ctx.ttlSec,
      guardInstanceId: this.guardInstanceId,
      basis: ctx.basis,
    };
    return signAuthorization(this.account, unsigned);
  }
}
