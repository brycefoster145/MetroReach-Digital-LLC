/**
 * Phase 2 — Caller Memory & Recognition
 *
 * Remembers returning callers across sessions.
 * Tracks call history, preferences, and notes.
 */

import { randomUUID } from "node:crypto";
import { getCallerProfile, upsertCallerProfile, getCallerCalls, getCallerProfile as getProfile } from "./db.js";

export interface CallerProfile {
  id: string;
  tenant_id: string;
  phone_number: string;
  name: string | null;
  email: string | null;
  total_calls: number;
  last_call_at: string;
  tags: string[];
  notes: string;
  preferred_contact: string;
}

export interface CallerContext {
  profile: CallerProfile | null;
  isReturning: boolean;
  recentCalls: any[];
  personalizedGreeting: string;
}

function parseTags(tags: string): string[] {
  try { return JSON.parse(tags); } catch { return []; }
}

// ── Look up or create caller ──────────────────────────────
export async function recognizeCaller(
  tenantId: string,
  phoneNumber: string,
  callerName?: string,
): Promise<CallerContext> {
  const raw = await getProfile(tenantId, phoneNumber);
  const recentCalls = await getCallerCalls(tenantId, phoneNumber);

  if (raw) {
    const profile: CallerProfile = {
      ...raw,
      tags: parseTags(raw.tags || "[]"),
    };

    // Update call count and timestamp
    await upsertCallerProfile({
      id: raw.id,
      tenant_id: tenantId,
      phone_number: phoneNumber,
      name: callerName || raw.name,
    });

    const namePart = profile.name ? `, ${profile.name}` : "";
    const returningNote = profile.total_calls > 1
      ? `Welcome back${namePart}! I see you've called us ${profile.total_calls} times before.`
      : `Welcome back${namePart}!`;

    return {
      profile: { ...profile, total_calls: profile.total_calls + 1 },
      isReturning: true,
      recentCalls,
      personalizedGreeting: returningNote,
    };
  }

  // New caller
  const newId = randomUUID();
  await upsertCallerProfile({
    id: newId,
    tenant_id: tenantId,
    phone_number: phoneNumber,
    name: callerName,
  });

  return {
    profile: {
      id: newId,
      tenant_id: tenantId,
      phone_number: phoneNumber,
      name: callerName || null,
      email: null,
      total_calls: 1,
      last_call_at: new Date().toISOString(),
      tags: [],
      notes: "",
      preferred_contact: "phone",
    },
    isReturning: false,
    recentCalls: [],
    personalizedGreeting: "Thank you for calling us for the first time!",
  };
}

// ── Add tags to caller ────────────────────────────────────
export async function tagCaller(
  tenantId: string,
  phoneNumber: string,
  tags: string[],
): Promise<void> {
  const profile = await getCallerProfile(tenantId, phoneNumber);
  if (!profile) return;

  const existing = parseTags(profile.tags || "[]");
  const merged = [...new Set([...existing, ...tags])];

  await upsertCallerProfile({
    id: profile.id,
    tenant_id: tenantId,
    phone_number: phoneNumber,
    tags: JSON.stringify(merged),
  });
}

// ── Get caller summary for voice agent ────────────────────
export async function getCallerSummary(
  tenantId: string,
  phoneNumber: string,
): Promise<string> {
  const ctx = await recognizeCaller(tenantId, phoneNumber);

  if (!ctx.isReturning || !ctx.profile) return "";

  const parts: string[] = [];
  parts.push(ctx.profile.name ? `Caller: ${ctx.profile.name}` : "Caller: Unknown");
  parts.push(`Previous calls: ${ctx.profile.total_calls}`);

  if (ctx.profile.tags.length > 0) {
    parts.push(`Tags: ${ctx.profile.tags.join(", ")}`);
  }
  if (ctx.profile.notes) {
    parts.push(`Notes: ${ctx.profile.notes}`);
  }
  if (ctx.recentCalls.length > 0) {
    const lastCall = ctx.recentCalls[0];
    parts.push(`Last call: ${lastCall.created_at} (${lastCall.outcome || "completed"})`);
  }

  return parts.join(" | ");
}
