/** HTML/tag cleanup + length limit. Not a security boundary (§6.1). */
export function sanitize(body: string, maxChars = 8000): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

/**
 * Cheap, deterministic detector for text that tries to steer an AI.
 * Used in addition to the reader model's own flag; either one sets `contains_instructions`.
 */
const INSTRUCTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules)/i,
  /\b(system|developer) (prompt|message)\b/i,
  /\byou (are|must|should) now\b/i,
  /\b(ai|assistant|agent|bot|llm)s?\b[^.]{0,60}\b(must|should|need to|are instructed to)\b/i,
  /\b(buy|sell|transfer|withdraw)\b[^.]{0,40}\b(immediately|now|all|everything|max(imum)?)\b/i,
  /\bdisregard\b[^.]{0,40}\b(limits?|policy|rules)\b/i,
  /<\/?(instruction|system|prompt)>/i,
];

export function looksLikeInstructions(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((p) => p.test(text));
}
