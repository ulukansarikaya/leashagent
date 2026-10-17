/** Gateway-local request limits (§6.3 step 1, §6.3 step 4). */
export const LIMITS = {
  maxRequestBytes: 16 * 1024,
  clockSkewSec: 60,
} as const;
