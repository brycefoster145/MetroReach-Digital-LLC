/**
 * Phase 2 — Sentiment & Emotion Detection
 *
 * Analyzes call segments for emotional tone.
 * Uses keyword + pattern matching with OpenAI fallback.
 */

import { randomUUID } from "node:crypto";
import { saveSentimentLog, getCallSentiment } from "./db.js";

export type SentimentLabel = "positive" | "neutral" | "negative" | "frustrated" | "excited";

interface SentimentResult {
  label: SentimentLabel;
  score: number; // -1.0 (negative) to 1.0 (positive)
}

// ── Sentiment keyword lexicon ──────────────────────────────
const POSITIVE_WORDS = [
  "great", "wonderful", "excellent", "amazing", "perfect", "love",
  "thank you", "thanks", "appreciate", "happy", "good", "awesome",
  "fantastic", "pleased", "helpful", "wonderful",
];

const NEGATIVE_WORDS = [
  "bad", "terrible", "awful", "horrible", "frustrated", "angry",
  "upset", "disappointed", "unacceptable", "ridiculous", "waste",
  "never", "worst", "poor", "useless", "hate",
];

const EXCITED_WORDS = [
  "yes!", "finally", "let's do it", "sign me up", "i'm in",
  "absolutely", "definitely", "right away", "let's go",
];

const FRUSTRATED_WORDS = [
  "i've been waiting", "again?", "told me", "not working",
  "nobody", "no one", "called back", "multiple times", "third time",
];

// ── Detect sentiment from text ────────────────────────────
export function detectSentiment(text: string): SentimentResult {
  const lower = text.toLowerCase();
  let score = 0;
  let label: SentimentLabel = "neutral";

  // Count positive and negative signals
  let posHits = 0;
  let negHits = 0;

  for (const word of POSITIVE_WORDS) {
    if (lower.includes(word)) posHits++;
  }
  for (const word of NEGATIVE_WORDS) {
    if (lower.includes(word)) negHits++;
  }
  for (const word of EXCITED_WORDS) {
    if (lower.includes(word)) { posHits += 2; }
  }
  for (const word of FRUSTRATED_WORDS) {
    if (lower.includes(word)) { negHits += 2; }
  }

  // Calculate weighted score
  const total = posHits + negHits;
  if (total > 0) {
    score = (posHits - negHits) / Math.max(total, 4); // normalized -1 to 1
  }

  // Determine label
  if (score > 0.5 && lower.match(/yes!|finally|sign me up|let's do it/i)) {
    label = "excited";
  } else if (score > 0.3) {
    label = "positive";
  } else if (score < -0.5) {
    label = "frustrated";
  } else if (score < -0.2) {
    label = "negative";
  } else {
    label = "neutral";
  }

  return { label, score };
}

// ── Analyze call transcript segments ──────────────────────
export async function analyzeCallSentiment(
  tenantId: string,
  callId: string,
  segments: string[],
): Promise<SentimentResult[]> {
  const results: SentimentResult[] = [];

  for (const segment of segments) {
    const result = detectSentiment(segment);
    results.push(result);

    // Persist
    await saveSentimentLog({
      id: randomUUID(),
      tenant_id: tenantId,
      call_id: callId,
      segment_text: segment.slice(0, 500),
      sentiment: result.label,
      score: result.score,
    });
  }

  return results;
}

// ── Get overall sentiment from a call ─────────────────────
export async function getCallSentimentSummary(callId: string): Promise<{
  overall: SentimentLabel;
  averageScore: number;
  segments: any[];
}> {
  const logs = await getCallSentiment(callId);

  if (logs.length === 0) {
    return { overall: "neutral", averageScore: 0, segments: [] };
  }

  const avgScore = (logs as any[]).reduce((sum, l) => sum + (l.score || 0), 0) / logs.length;

  let overall: SentimentLabel = "neutral";
  if (avgScore > 0.3) overall = "positive";
  else if (avgScore < -0.3) overall = "negative";

  return {
    overall,
    averageScore: Math.round(avgScore * 100) / 100,
    segments: logs,
  };
}

// ── Sentiment-aware response guidance ─────────────────────
export function getSentimentGuidance(label: SentimentLabel): string {
  switch (label) {
    case "frustrated":
      return "CALLER IS FRUSTRATED — use empathetic tone, acknowledge their frustration, offer concrete solution or escalation path. Do NOT use generic scripts.";
    case "negative":
      return "Caller seems unhappy — validate their concern, avoid defensiveness, offer to make things right.";
    case "excited":
      return "Caller is enthusiastic — match their energy, move toward closing or booking quickly.";
    case "positive":
      return "Caller is happy — maintain warm tone, look for upsell or referral opportunity.";
    default:
      return "";
  }
}
