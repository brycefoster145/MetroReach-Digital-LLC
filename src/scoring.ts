/**
 * Phase 2 — Lead Qualification & Scoring
 *
 * Scores leads based on behavior: engagement, intent signals,
 * call duration, appointment bookings, payment willingness.
 */

import { randomUUID } from "node:crypto";
import { saveLeadScore, getLeadScores } from "./db.js";

export interface ScoreFactors {
  engagement: number;     // 0-30: answered questions, call duration
  intent: number;         // 0-30: mentioned buying, asked pricing
  urgency: number;        // 0-20: used urgent language, "right now", "today"
  budget: number;         // 0-20: discussed payment, accepted price
  // ── total: 0-100 ──
}

export type LeadTier = "hot" | "warm" | "cold";

function classifyTier(score: number): LeadTier {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

// ── Score a lead from call/interaction signals ────────────
export async function scoreLead(
  tenantId: string,
  signals: {
    leadId?: string;
    callerProfileId?: string;
    transcript?: string;
    callDuration?: number;
    didBookAppointment?: boolean;
    didAskPricing?: boolean;
    didMentionUrgency?: boolean;
    didDiscussPayment?: boolean;
  },
): Promise<{ score: number; tier: LeadTier; factors: ScoreFactors }> {
  const factors: ScoreFactors = {
    engagement: 0,
    intent: 0,
    urgency: 0,
    budget: 0,
  };

  // Engagement: call duration & participation
  if (signals.callDuration && signals.callDuration > 120) {
    factors.engagement = 25; // engaged call
  } else if (signals.callDuration && signals.callDuration > 60) {
    factors.engagement = 15;
  } else if (signals.callDuration) {
    factors.engagement = 5;
  }

  if (signals.transcript && signals.transcript.length > 200) {
    factors.engagement = Math.min(30, factors.engagement + 5);
  }

  // Intent: appointment booking is strong signal
  if (signals.didBookAppointment) {
    factors.intent = 30;
  } else if (signals.didAskPricing) {
    factors.intent = 20;
  }

  // Urgency
  if (signals.didMentionUrgency) {
    factors.urgency = 20;
  }

  // Budget
  if (signals.didDiscussPayment) {
    factors.budget = 15;
  }

  const score = factors.engagement + factors.intent + factors.urgency + factors.budget;
  const tier = classifyTier(score);

  // Persist
  await saveLeadScore({
    id: randomUUID(),
    tenant_id: tenantId,
    lead_id: signals.leadId,
    caller_profile_id: signals.callerProfileId,
    score,
    tier,
    factors: JSON.stringify(factors),
  });

  return { score, tier, factors };
}

// ── Analyze transcript for scoring signals ────────────────
export function analyzeTranscriptForSignals(transcript: string): {
  didAskPricing: boolean;
  didMentionUrgency: boolean;
  didDiscussPayment: boolean;
} {
  const lower = transcript.toLowerCase();

  return {
    didAskPricing: /how much|price|cost|rate|fee|charge|pricing/i.test(lower),
    didMentionUrgency: /urgent|asap|right now|today|immediately|emergency|quick/i.test(lower),
    didDiscussPayment: /pay|payment|deposit|invoice|card|credit|billing/i.test(lower),
  };
}

// ── Get top leads ─────────────────────────────────────────
export async function getTopLeads(tenantId: string, tier?: LeadTier) {
  const scores = await getLeadScores(tenantId);
  if (tier) return scores.filter((s: any) => s.tier === tier);
  return scores;
}
