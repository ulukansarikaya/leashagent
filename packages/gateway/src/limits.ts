/** Gateway-local request limits (§6.3 step 1, §6.3 step 4). */
export const LIMITS = {
  maxRequestBytes: 16 * 1024,
  clockSkewSec: 60,
} as const;

/**
 * PROPOSED reason code (not in shared `ReasonCodes` / §12): a sell exceeding fresh available base
 * inventory (§6.4 says REJECTED_POLICY but assigns no code). Kept local to the gateway until all
 * three owners agree to add it to `@bekci/shared` (§25.7). Fits uint16 for DecisionLog.
 */
export const SELL_INVENTORY_REASON = 108;
