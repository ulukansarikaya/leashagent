import { hashText, recoverAgentReadSigner, type Hex, type ReadRecord, type ReadRequest, type ReadSummary } from "@bekci/shared";
import type { ContentSource } from "./fetcher.js";
import type { ReadRecorder } from "./recorder.js";
import type { ReaderModel } from "./reader.js";
import { looksLikeInstructions, sanitize } from "./sanitizer.js";

export interface IngestService {
  read(req: ReadRequest): Promise<ReadSummary>;
}

export type IngestDeps = {
  source: ContentSource;
  reader: ReaderModel;
  recorder: ReadRecorder;
  /** Resolve the delegated agent address for a policy; reads with a bad signature are refused. */
  agentAddressFor: (policyId: Hex) => Promise<Hex | undefined>;
  onRecorded?: (r: ReadRecord) => void;
};

export class IngestError extends Error {}

export class DefaultIngestService implements IngestService {
  constructor(private d: IngestDeps) {}

  async read(req: ReadRequest): Promise<ReadSummary> {
    if (req.query.length > 512) throw new IngestError("query too long");
    const expected = await this.d.agentAddressFor(req.policyId);
    const signer = await recoverAgentReadSigner(req).catch(() => undefined);
    if (!expected || !signer || signer.toLowerCase() !== expected.toLowerCase()) throw new IngestError("bad agent signature");

    const items = await this.d.source.fetch(req.source, req.query);
    const summaries: ReadSummary[] = [];
    for (const raw of items) {
      const text = sanitize(raw.body);
      let summary: ReadSummary;
      try {
        summary = await this.d.reader.summarize({ source: req.source, text, url: raw.url });
      } catch {
        continue; // out-of-schema reader output is discarded
      }
      // Defense in depth: our own detector can add the flag, never remove it.
      if (looksLikeInstructions(text) && !summary.flags.includes("contains_instructions")) {
        summary = { ...summary, flags: [...summary.flags, "contains_instructions"] };
      }
      const record: ReadRecord = {
        readId: summary.readId,
        policyId: req.policyId,
        fetchedAt: raw.fetchedAt,
        contentHash: hashText(raw.body),
        excerpt: text.slice(0, 1000),
        summary,
      };
      await this.d.recorder.record(record);
      this.d.onRecorded?.(record);
      summaries.push(summary);
    }
    return mergeSummaries(req.source, summaries);
  }
}

/** One ReadSummary per request: union of bounded fields across items. */
function mergeSummaries(source: string, s: ReadSummary[]): ReadSummary {
  if (s.length === 0) {
    return { readId: crypto.randomUUID(), source, topics: [], sentiment: "unknown", confidence: "0", sourceUrls: [], flags: ["low_quality"] };
  }
  if (s.length === 1) return s[0]!;
  const sentiments = new Set(s.map((x) => x.sentiment));
  return {
    readId: s[0]!.readId,
    source,
    topics: [...new Set(s.flatMap((x) => x.topics))].slice(0, 10),
    sentiment: sentiments.size === 1 ? s[0]!.sentiment : "neutral",
    confidence: s.map((x) => x.confidence).sort()[0]!,
    sourceUrls: [...new Set(s.flatMap((x) => x.sourceUrls))].slice(0, 5),
    flags: [...new Set(s.flatMap((x) => x.flags))],
  };
}
