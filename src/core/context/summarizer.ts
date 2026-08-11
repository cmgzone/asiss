/**
 * Summarizer — Hermes Evolution Phase 7.
 *
 * Collapses long context sections (old conversation turns, oversized tool
 * outputs, repository dumps) into concise summaries instead of hard
 * truncation. The summarization model is injectable; without one, a smart
 * lossy fallback keeps the informative head + tail. A content-hash cache
 * guarantees identical inputs are never re-summarized (cost control).
 */

import { createHash } from 'crypto';

export type SummarizeFn = (text: string, instruction: string) => Promise<string>;

export interface SummarizerOptions {
  /** Model-backed summarizer. Absent => fallback truncation only. */
  summarize?: SummarizeFn;
  /** Minimum length before summarization is attempted. Default 6000 chars. */
  minChars?: number;
  /** Target maximum chars of a summary. Default 3000. */
  maxChars?: number;
  /** Cache size (unique inputs kept). Default 200. */
  cacheSize?: number;
}

export class Summarizer {
  private readonly summarizeFn?: SummarizeFn;
  private readonly minChars: number;
  private readonly maxChars: number;
  private readonly cacheSize: number;
  private readonly cache = new Map<string, string>();

  constructor(options: SummarizerOptions = {}) {
    this.summarizeFn = options.summarize;
    this.minChars = options.minChars ?? 6000;
    this.maxChars = options.maxChars ?? 3000;
    this.cacheSize = options.cacheSize ?? 200;
  }

  /**
   * Summarize a section. Returns the original when it is short enough or no
   * model is available (fallback truncation still applies via budget).
   */
  async summarize(text: string, instruction = 'Preserve facts, decisions, results and open questions.'): Promise<string> {
    if (!text || text.length <= this.minChars) return text;
    if (!this.summarizeFn) return this.fallback(text);

    const key = createHash('sha256').update(text.slice(0, 4000)).digest('hex');
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const summary = await this.summarizeFn(text, instruction);
    const final = summary.length > this.maxChars ? this.fallback(summary) : summary;
    this.cache.set(key, final);
    if (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return final;
  }

  /**
   * Lossy fallback: keep the head, drop repeated/noisy middle content, and
   * keep the tail. Never throws.
   */
  fallback(text: string, maxChars = this.maxChars): string {
    if (text.length <= maxChars) return text;
    const head = text.slice(0, Math.floor(maxChars * 0.6));
    const tail = text.slice(-Math.floor(maxChars * 0.25));
    const removed = text.length - head.length - tail.length;
    return `${head}\n... [summarized, ${removed} chars of repetition/detail removed] ...\n${tail}`;
  }

  /** Collapse near-duplicate consecutive lines (common in tool output dumps). */
  static collapseRepeated(text: string, maxRepeats = 3): string {
    const lines = String(text || '').split('\n');
    const out: string[] = [];
    let run = 1;
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0 && lines[i] === lines[i - 1] && lines[i] !== '') {
        run += 1;
        if (run > maxRepeats) continue;
      } else {
        run = 1;
      }
      out.push(lines[i]);
    }
    return out.join('\n');
  }
}
