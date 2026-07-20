/**
 * Phase 4 — Analytics Dashboard
 *
 * Business intelligence: call volume, conversion rates,
 * lead sources, revenue, staff performance, satisfaction.
 */

import { getTenantBySlug, getAnalyticsSummary, getCallVolumeByDay, getLeadsBySource, getSentimentSummary, getPaymentIntents, getCalls, getLeads } from "./db.js";
import { getLeadScores } from "./db.js";

export interface DashboardData {
  summary: {
    totalCalls: number;
    totalLeads: number;
    totalAppointments: number;
    totalRevenue: number;
    avgCallDuration: number;
    conversionRate: number;
  };
  callVolumeByDay: Array<{ day: string; count: number }>;
  leadsBySource: Array<{ source: string; count: number }>;
  sentimentDistribution: Array<{ sentiment: string; count: number }>;
  topLeads: Array<{ score: number; tier: string }>;
  recentCalls: Array<any>;
  recentPayments: Array<any>;
  timeSavedEstimate: number;
  revenueThisMonth: number;
}

// ── Build full dashboard ──────────────────────────────────
export async function getDashboard(slug: string): Promise<DashboardData | null> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return null;

  const [summary, volume, sources, sentiment, scores, calls, payments] = await Promise.all([
    getAnalyticsSummary(tenant.id),
    getCallVolumeByDay(tenant.id, 7),
    getLeadsBySource(tenant.id),
    getSentimentSummary(tenant.id),
    getLeadScores(tenant.id),
    getCalls(tenant.id),
    getPaymentIntents(tenant.id),
  ]);

  // Time saved: assume 5 min/call that AI handled instead of human
  const timeSavedMinutes = summary.totalCalls * 5;

  // Revenue this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const revenueThisMonth = (payments as any[])
    .filter(p => p.status === "completed" && p.completed_at >= monthStart)
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  return {
    summary,
    callVolumeByDay: volume as any[],
    leadsBySource: sources as any[],
    sentimentDistribution: sentiment as any[],
    topLeads: (scores as any[]).slice(0, 10),
    recentCalls: (calls as any[]).slice(0, 10),
    recentPayments: (payments as any[]).slice(0, 10),
    timeSavedEstimate: timeSavedMinutes,
    revenueThisMonth,
  };
}

// ── Quick stats for Telegram bot ──────────────────────────
export async function getQuickStats(slug: string): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return "Business not found.";

  const summary = await getAnalyticsSummary(tenant.id);

  const formatUSD = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  return [
    `📊 <b>${tenant.name} — Analytics</b>`,
    ``,
    `📞 Total Calls: <b>${summary.totalCalls}</b>`,
    `👤 Leads Captured: <b>${summary.totalLeads}</b>`,
    `📅 Appointments: <b>${summary.totalAppointments}</b>`,
    `💰 Revenue: <b>${formatUSD(summary.totalRevenue)}</b>`,
    `⏱ Avg Call: <b>${summary.avgCallDuration}s</b>`,
    `🎯 Conversion: <b>${summary.conversionRate}%</b>`,
    ``,
    `⏳ Est. Time Saved: <b>${Math.round(summary.totalCalls * 5 / 60)} hrs</b> (vs human staff)`,
  ].join("\n");
}

// ── Staff performance summary ─────────────────────────────
export async function getStaffPerformance(slug: string): Promise<any[]> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return [];

  // Aggregate calls by staff (from appointments.staff_name)
  const calls = await getCalls(tenant.id);
  const staffMap = new Map<string, { calls: number; appointments: number; totalDuration: number }>();

  // Simplified — in production, join calls to appointments by caller
  return Array.from(staffMap.entries()).map(([name, stats]) => ({
    name,
    ...stats,
  }));
}

// ── Customer satisfaction score ────────────────────────────
export async function getCustomerSatisfaction(slug: string): Promise<{
  score: number; // 0-100
  positive: number;
  negative: number;
  neutral: number;
  total: number;
}> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return { score: 0, positive: 0, negative: 0, neutral: 0, total: 0 };

  const sentiments = await getSentimentSummary(tenant.id);
  const data = sentiments as any[];

  let positive = 0, negative = 0, neutral = 0;
  for (const s of data) {
    if (s.sentiment === "positive" || s.sentiment === "excited") positive += s.count;
    else if (s.sentiment === "negative" || s.sentiment === "frustrated") negative += s.count;
    else neutral += s.count;
  }

  const total = positive + negative + neutral;
  const score = total > 0 ? Math.round((positive / total) * 100) : 0;

  return { score, positive, negative, neutral, total };
}
