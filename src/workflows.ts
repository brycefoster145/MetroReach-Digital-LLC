/**
 * Phase 3 — Workflow Automation
 *
 * Trigger-based automation engine. Listens for events
 * (new_lead, call_ended, appointment_booked, payment_received)
 * and runs configured action sequences.
 */

import { randomUUID } from "node:crypto";
import { getWorkflowsByTrigger, logWorkflowRun } from "./db.js";
import { sendSms } from "./sms.js";
import { sendEmail } from "./email.js";
import type { FollowUpConfig } from "./followups.js";
import { postCallFollowUp } from "./followups.js";

// ── Trigger event types ───────────────────────────────────
export type TriggerEvent =
  | "new_lead"
  | "call_ended"
  | "appointment_booked"
  | "appointment_cancelled"
  | "payment_received"
  | "payment_failed"
  | "caller_returned"
  | "negative_sentiment";

export interface TriggerPayload {
  event: TriggerEvent;
  tenantId: string;
  data: Record<string, any>;
}

// ── Action types ──────────────────────────────────────────
export type Action =
  | { type: "send_sms"; phone: string; body: string }
  | { type: "send_email"; email: string; subject: string; body: string }
  | { type: "tag_caller"; phone: string; tags: string[] }
  | { type: "notify_owner"; message: string }
  | { type: "follow_up_sequence"; config: FollowUpConfig; outcome: any }
  | { type: "webhook"; url: string; payload: Record<string, unknown> };

// ── Execute a single action ───────────────────────────────
export async function executeAction(tenantId: string, action: Action): Promise<{ success: boolean; result: string }> {
  try {
    switch (action.type) {
      case "send_sms": {
        const { sendSms } = await import("./sms.js");
        const r = await sendSms(tenantId, action.phone, action.body);
        return { success: r.success, result: r.success ? `SMS sent to ${action.phone}` : "SMS failed" };
      }
      case "send_email": {
        const { sendEmail } = await import("./email.js");
        const r = await sendEmail(tenantId, action.email, action.subject, action.body);
        return { success: r.success, result: r.success ? `Email sent to ${action.email}` : "Email failed" };
      }
      case "tag_caller": {
        const { tagCaller } = await import("./memory.js");
        await tagCaller(tenantId, action.phone, action.tags);
        return { success: true, result: `Tagged ${action.phone}: ${action.tags.join(", ")}` };
      }
      case "notify_owner": {
        // Send via Telegram bot if available
        try {
          const { notifyOwner } = await import("../../telegram-bot/bot.js");
          await notifyOwner(action.message);
        } catch {
          console.log("[workflow] Telegram notification:", action.message);
        }
        return { success: true, result: "Owner notified" };
      }
      case "follow_up_sequence": {
        const r = await postCallFollowUp(action.config, action.outcome);
        return { success: true, result: `Follow-up: SMS=${r.sms} Email=${r.email}` };
      }
      case "webhook": {
        const res = await fetch(action.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action.payload),
        });
        return { success: res.ok, result: `Webhook ${res.status}` };
      }
      default:
        return { success: false, result: "Unknown action type" };
    }
  } catch (err: any) {
    return { success: false, result: err.message };
  }
}

// ── Evaluate conditions ────────────────────────────────────
function evaluateConditions(conditions: Record<string, any>, payload: TriggerPayload): boolean {
  // Simple condition matching: { "sentiment": "negative", "callDuration_gt": 60 }
  for (const [key, value] of Object.entries(conditions)) {
    if (key === "sentiment" && payload.data.sentiment !== value) return false;
    if (key === "tier" && payload.data.tier !== value) return false;
    if (key === "callDuration_gt" && (payload.data.callDuration || 0) <= Number(value)) return false;
    if (key === "callDuration_lt" && (payload.data.callDuration || 0) >= Number(value)) return false;
    if (key === "score_gt" && (payload.data.score || 0) <= Number(value)) return false;
  }
  return true;
}

// ── Fire trigger — main entry point ────────────────────────
export async function fireTrigger(payload: TriggerPayload): Promise<{ workflowsTriggered: number; actionsRun: number }> {
  const workflows = await getWorkflowsByTrigger(payload.tenantId, payload.event);

  if (!workflows || (workflows as any[]).length === 0) {
    return { workflowsTriggered: 0, actionsRun: 0 };
  }

  let workflowsTriggered = 0;
  let actionsRun = 0;

  for (const wf of workflows as any[]) {
    // Parse conditions
    let conditions: Record<string, any> = {};
    try { conditions = JSON.parse(wf.conditions || "{}"); } catch {}

    if (!evaluateConditions(conditions, payload)) continue;

    // Parse actions
    let actions: Action[] = [];
    try { actions = JSON.parse(wf.actions || "[]"); } catch { continue; }

    const results: string[] = [];
    for (const action of actions) {
      const result = await executeAction(payload.tenantId, action);
      results.push(`${action.type}: ${result.result}`);
      actionsRun++;
    }

    // Log workflow run
    await logWorkflowRun({
      id: randomUUID(),
      tenant_id: payload.tenantId,
      workflow_id: wf.id,
      trigger_data: JSON.stringify(payload.data),
      status: "completed",
      results: JSON.stringify(results),
    });

    workflowsTriggered++;
  }

  return { workflowsTriggered, actionsRun };
}

// ── Pre-built workflow templates ──────────────────────────

export const WORKFLOW_TEMPLATES = {
  hotLeadAlert: {
    name: "Hot Lead — Alert Owner",
    trigger_event: "new_lead" as TriggerEvent,
    conditions: { tier: "hot" },
    actions: JSON.stringify([
      { type: "notify_owner", message: "🔥 Hot lead! Score > 70 — follow up immediately." },
    ]),
  },

  negativeSentimentEscalate: {
    name: "Negative Sentiment — Escalate",
    trigger_event: "negative_sentiment",
    conditions: { sentiment: "frustrated" },
    actions: JSON.stringify([
      { type: "notify_owner", message: "⚠️ Frustrated caller detected — may need manager intervention." },
    ]),
  },

  postCallThankYou: {
    name: "Post-Call Thank You SMS",
    trigger_event: "call_ended",
    conditions: {},
    actions: JSON.stringify([
      { type: "send_sms", phone: "{{caller_phone}}", body: "Thanks for calling {{business_name}}! We appreciate your business." },
    ]),
  },

  appointmentConfirmation: {
    name: "Appointment — Send Confirmation",
    trigger_event: "appointment_booked",
    conditions: {},
    actions: JSON.stringify([
      {
        type: "follow_up_sequence",
        config: {
          businessName: "{{business_name}}",
        },
        outcome: { type: "appointment_booked", details: "{{appointment}}" },
      },
    ]),
  },
};
