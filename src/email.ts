/**
 * Phase 3 — Email Integration
 *
 * Sends invoices, receipts, summaries, follow-ups.
 * Uses SMTP via nodemailer-style fetch, or third-party API.
 */

import { randomUUID } from "node:crypto";
import { saveMessage } from "./db.js";

interface EmailConfig {
  provider?: "smtp" | "sendgrid" | "none";
  sendgridApiKey?: string;
  fromEmail?: string;
  fromName?: string;
}

function getEmailConfig(): EmailConfig {
  return {
    provider: (process.env.EMAIL_PROVIDER as any) || "none",
    sendgridApiKey: process.env.SENDGRID_API_KEY,
    fromEmail: process.env.FROM_EMAIL || "hello@metroreach.digital",
    fromName: process.env.FROM_NAME || "MetroReach Digital",
  };
}

// ── Send via SendGrid ─────────────────────────────────────
async function sendViaSendgrid(
  to: string,
  subject: string,
  htmlBody: string,
): Promise<boolean> {
  const config = getEmailConfig();
  if (!config.sendgridApiKey) return false;

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.sendgridApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.fromEmail, name: config.fromName },
      subject,
      content: [{ type: "text/html", value: htmlBody }],
    }),
  });

  return res.status === 202;
}

// ── Public API ────────────────────────────────────────────

export async function sendEmail(
  tenantId: string,
  to: string,
  subject: string,
  htmlBody: string,
  metadata: Record<string, string> = {},
): Promise<{ success: boolean; messageId: string }> {
  const messageId = randomUUID();
  const config = getEmailConfig();

  try {
    let sent = false;
    if (config.provider === "sendgrid" && config.sendgridApiKey) {
      sent = await sendViaSendgrid(to, subject, htmlBody);
    }
    // Future: add SMTP support here

    await saveMessage({
      id: messageId,
      tenant_id: tenantId,
      recipient: to,
      channel: "email",
      direction: "outbound",
      body: htmlBody.slice(0, 2000),
      status: sent ? "sent" : "failed",
      metadata: JSON.stringify({ ...metadata, subject }),
    });

    return { success: sent, messageId };
  } catch (err: any) {
    await saveMessage({
      id: messageId,
      tenant_id: tenantId,
      recipient: to,
      channel: "email",
      direction: "outbound",
      body: htmlBody.slice(0, 500),
      status: "failed",
      metadata: JSON.stringify({ ...metadata, error: err.message, subject }),
    });
    return { success: false, messageId };
  }
}

// ── Send invoice ──────────────────────────────────────────
export async function sendInvoice(
  tenantId: string,
  to: string,
  amount: number,
  description: string,
  businessName: string,
): Promise<{ success: boolean; messageId: string }> {
  const dollars = (amount / 100).toFixed(2);
  const subject = `Invoice from ${businessName} — $${dollars}`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>${businessName}</h2>
      <h3>Invoice</h3>
      <p>${description}</p>
      <p style="font-size:24px;font-weight:bold;">$${dollars}</p>
      <p>Thank you for your business!</p>
      <hr/>
      <p style="color:#888;font-size:12px;">Sent by MetroReach Digital</p>
    </div>
  `;
  return sendEmail(tenantId, to, subject, html, { type: "invoice", amount: String(amount) });
}

// ── Send call summary ─────────────────────────────────────
export async function sendCallSummary(
  tenantId: string,
  to: string,
  summary: string,
  businessName: string,
): Promise<{ success: boolean; messageId: string }> {
  const subject = `Call summary from ${businessName}`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>${businessName}</h2>
      <h3>Call Summary</h3>
      <p>${summary}</p>
      <p>If you have questions, please call us back.</p>
    </div>
  `;
  return sendEmail(tenantId, to, subject, html, { type: "call_summary" });
}
