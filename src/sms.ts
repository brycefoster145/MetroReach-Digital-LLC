/**
 * Phase 3 — SMS Integration (Twilio)
 *
 * Send follow-ups, reminders, confirmations via SMS.
 * Track delivery status and responses.
 */

import { randomUUID } from "node:crypto";
import { saveMessage } from "./db.js";

// Twilio creds from env
function getTwilioCreds(): { accountSid: string; authToken: string; fromNumber: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER || "+19083390116";
  if (!sid || !token) return null;
  return { accountSid: sid, authToken: token, fromNumber: from };
}

async function twilioRequest(endpoint: string, body: Record<string, string>): Promise<any> {
  const creds = getTwilioCreds();
  if (!creds) throw new Error("Twilio not configured");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/${endpoint}`;
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  return res.json();
}

// ── Send SMS ──────────────────────────────────────────────
export async function sendSms(
  tenantId: string,
  to: string,
  body: string,
  metadata: Record<string, string> = {},
): Promise<{ success: boolean; messageId: string; sid?: string }> {
  const messageId = randomUUID();

  try {
    const creds = getTwilioCreds();
    if (!creds) {
      // Log locally even if Twilio not configured
      await saveMessage({
        id: messageId,
        tenant_id: tenantId,
        recipient: to,
        channel: "sms",
        direction: "outbound",
        body,
        status: "failed",
        metadata: JSON.stringify({ ...metadata, error: "Twilio not configured" }),
      });
      return { success: false, messageId };
    }

    const result = await twilioRequest("Messages.json", {
      To: to,
      From: creds.fromNumber,
      Body: body,
    });

    const sid = result.sid;

    await saveMessage({
      id: messageId,
      tenant_id: tenantId,
      recipient: to,
      channel: "sms",
      direction: "outbound",
      body,
      status: result.error_code ? "failed" : "sent",
      external_id: sid,
      metadata: JSON.stringify(metadata),
    });

    return { success: !result.error_code, messageId, sid };
  } catch (err: any) {
    await saveMessage({
      id: messageId,
      tenant_id: tenantId,
      recipient: to,
      channel: "sms",
      direction: "outbound",
      body,
      status: "failed",
      metadata: JSON.stringify({ ...metadata, error: err.message }),
    });
    return { success: false, messageId };
  }
}

// ── Send appointment reminder ─────────────────────────────
export async function sendAppointmentReminder(
  tenantId: string,
  to: string,
  appointment: { dateTime: string; staffName?: string; businessName: string },
): Promise<{ success: boolean; messageId: string }> {
  const date = new Date(appointment.dateTime).toLocaleString();
  const staff = appointment.staffName ? ` with ${appointment.staffName}` : "";

  const body = [
    `📅 Reminder: Your appointment${staff} at ${appointment.businessName} is on ${date}.`,
    `Reply STOP to opt out.`,
  ].join(" ");

  return sendSms(tenantId, to, body, { type: "appointment_reminder" });
}

// ── Send payment confirmation ─────────────────────────────
export async function sendPaymentConfirmation(
  tenantId: string,
  to: string,
  amount: number,
  businessName: string,
): Promise<{ success: boolean; messageId: string }> {
  const body = `✅ Payment of $${(amount / 100).toFixed(2)} received. Thank you for your business with ${businessName}!`;
  return sendSms(tenantId, to, body, { type: "payment_confirmation", amount: String(amount) });
}
