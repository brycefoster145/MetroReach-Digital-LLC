/**
 * Phase 4 — Multi-Channel Expansion
 *
 * WhatsApp (Twilio), Facebook Messenger (Graph API),
 * Instagram DM (Graph API).
 */

import { randomUUID } from "node:crypto";
import { saveMessage } from "./db.js";

// ── Twilio WhatsApp ───────────────────────────────────────

function getTwilioCreds(): { accountSid: string; authToken: string; whatsappFrom: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
  if (!sid || !token || !from) return null;
  return { accountSid: sid, authToken: token, whatsappFrom: from };
}

export async function sendWhatsApp(
  tenantId: string,
  to: string,
  body: string,
): Promise<{ success: boolean; messageId: string; sid?: string }> {
  const messageId = randomUUID();
  const creds = getTwilioCreds();

  if (!creds) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: to, channel: "whatsapp",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: "WhatsApp not configured" }),
    });
    return { success: false, messageId };
  }

  try {
    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: `whatsapp:${to}`,
          From: `whatsapp:${creds.whatsappFrom}`,
          Body: body,
        }).toString(),
      },
    );

    const data = await res.json();

    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: to, channel: "whatsapp",
      direction: "outbound", body, status: data.error_code ? "failed" : "sent",
      external_id: data.sid, metadata: "{}",
    });

    return { success: !data.error_code, messageId, sid: data.sid };
  } catch (err: any) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: to, channel: "whatsapp",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: err.message }),
    });
    return { success: false, messageId };
  }
}

// ── Facebook Messenger (Graph API) ────────────────────────

function getFacebookConfig(): { pageAccessToken: string } | null {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) return null;
  return { pageAccessToken: token };
}

export async function sendFacebookMessage(
  tenantId: string,
  recipientPsid: string,
  body: string,
): Promise<{ success: boolean; messageId: string }> {
  const messageId = randomUUID();
  const config = getFacebookConfig();

  if (!config) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientPsid, channel: "facebook",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: "Facebook not configured" }),
    });
    return { success: false, messageId };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${config.pageAccessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientPsid },
          message: { text: body },
        }),
      },
    );

    const data = await res.json();

    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientPsid, channel: "facebook",
      direction: "outbound", body, status: data.error ? "failed" : "sent",
      external_id: data.message_id, metadata: "{}",
    });

    return { success: !data.error, messageId };
  } catch (err: any) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientPsid, channel: "facebook",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: err.message }),
    });
    return { success: false, messageId };
  }
}

// ── Instagram DM (Graph API) ──────────────────────────────

export async function sendInstagramMessage(
  tenantId: string,
  recipientId: string,
  body: string,
): Promise<{ success: boolean; messageId: string }> {
  const messageId = randomUUID();
  const config = getFacebookConfig(); // Instagram uses same Graph API token

  if (!config) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientId, channel: "instagram",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: "Instagram not configured" }),
    });
    return { success: false, messageId };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v18.0/me/messages?access_token=${config.pageAccessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: { text: body },
        }),
      },
    );

    const data = await res.json();

    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientId, channel: "instagram",
      direction: "outbound", body, status: data.error ? "failed" : "sent",
      external_id: data.message_id, metadata: "{}",
    });

    return { success: !data.error, messageId };
  } catch (err: any) {
    await saveMessage({
      id: messageId, tenant_id: tenantId, recipient: recipientId, channel: "instagram",
      direction: "outbound", body, status: "failed",
      metadata: JSON.stringify({ error: err.message }),
    });
    return { success: false, messageId };
  }
}

// ── Multi-channel webhook handler (for incoming) ───────────

export interface IncomingMessage {
  channel: "whatsapp" | "facebook" | "instagram" | "sms";
  from: string;
  body: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export function parseTwilioWhatsAppWebhook(body: any): IncomingMessage | null {
  if (!body.From || !body.Body) return null;
  return {
    channel: "whatsapp",
    from: body.From.replace("whatsapp:", ""),
    body: body.Body,
    timestamp: new Date().toISOString(),
    metadata: { messageSid: body.MessageSid },
  };
}

export function parseFacebookWebhook(body: any): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  try {
    for (const entry of body.entry || []) {
      for (const messaging of entry.messaging || []) {
        if (messaging.message?.text) {
          messages.push({
            channel: "facebook",
            from: messaging.sender?.id || "unknown",
            body: messaging.message.text,
            timestamp: new Date(messaging.timestamp || Date.now()).toISOString(),
            metadata: { mid: messaging.message.mid },
          });
        }
      }
    }
  } catch {}
  return messages;
}
