/**
 * Phase 3 — Automated Follow-ups & Reminders
 *
 * Triggers SMS/email sequences based on call outcomes.
 * Scheduled reminders for appointments, payment follow-ups.
 */

import { sendSms, sendAppointmentReminder, sendPaymentConfirmation } from "./sms.js";
import { sendEmail, sendInvoice, sendCallSummary } from "./email.js";

export interface FollowUpConfig {
  tenantId: string;
  phone?: string;
  email?: string;
  businessName: string;
}

// ── Post-call follow-up sequence ──────────────────────────
export async function postCallFollowUp(
  config: FollowUpConfig,
  outcome: {
    type: "appointment_booked" | "lead_captured" | "payment_requested" | "general_inquiry" | "voicemail";
    details: Record<string, any>;
  },
): Promise<{ sms: boolean; email: boolean }> {
  const result = { sms: false, email: false };

  switch (outcome.type) {
    case "appointment_booked": {
      const appt = outcome.details;
      if (config.phone) {
        const sms = await sendAppointmentReminder(config.tenantId, config.phone, {
          dateTime: appt.dateTime,
          staffName: appt.staffName,
          businessName: config.businessName,
        });
        result.sms = sms.success;
      }
      if (config.email) {
        const email = await sendEmail(config.tenantId, config.email,
          `Appointment Confirmed — ${config.businessName}`,
          `<h2>Appointment Confirmed</h2><p>Your appointment is scheduled for ${new Date(appt.dateTime).toLocaleString()}.</p>`,
          { type: "appointment_confirmation" },
        );
        result.email = email.success;
      }
      break;
    }

    case "lead_captured": {
      if (config.phone) {
        const sms = await sendSms(config.tenantId, config.phone,
          `Thanks for reaching out to ${config.businessName}! We'll follow up with you shortly.`,
          { type: "lead_acknowledgment" },
        );
        result.sms = sms.success;
      }
      if (config.email) {
        const email = await sendEmail(config.tenantId, config.email,
          `We received your inquiry — ${config.businessName}`,
          `<h2>Thank you for your inquiry</h2><p>We received your message and will get back to you within 24 hours.</p>`,
          { type: "lead_acknowledgment" },
        );
        result.email = email.success;
      }
      break;
    }

    case "payment_requested": {
      if (config.email) {
        const email = await sendInvoice(
          config.tenantId, config.email,
          outcome.details.amount,
          outcome.details.description || "Services",
          config.businessName,
        );
        result.email = email.success;
      }
      if (config.phone) {
        const sms = await sendSms(config.tenantId, config.phone,
          `📋 An invoice for $${(outcome.details.amount / 100).toFixed(2)} from ${config.businessName} has been sent to your email.`,
          { type: "invoice_notification" },
        );
        result.sms = sms.success;
      }
      break;
    }

    case "general_inquiry": {
      if (config.phone) {
        const sms = await sendSms(config.tenantId, config.phone,
          `Thanks for calling ${config.businessName}! If you need anything else, just reply or call us back.`,
          { type: "post_call" },
        );
        result.sms = sms.success;
      }
      break;
    }

    case "voicemail": {
      if (config.phone) {
        const sms = await sendSms(config.tenantId, config.phone,
          `We received your voicemail at ${config.businessName}. Someone will call you back soon.`,
          { type: "voicemail_ack" },
        );
        result.sms = sms.success;
      }
      break;
    }
  }

  return result;
}

// ── Payment follow-up sequence ────────────────────────────
export async function paymentFollowUpSequence(
  config: FollowUpConfig,
  paymentDetails: { amount: number; description: string },
): Promise<void> {
  // Day 0: immediate invoice
  if (config.email) {
    await sendInvoice(config.tenantId, config.email, paymentDetails.amount, paymentDetails.description, config.businessName);
  }

  // Day 3: SMS reminder (would need a scheduler in production)
  if (config.phone) {
    await sendSms(config.tenantId, config.phone,
      `Hi, just a friendly reminder that an invoice for $${(paymentDetails.amount / 100).toFixed(2)} from ${config.businessName} is still pending. Let us know if you have questions!`,
      { type: "payment_reminder" },
    );
  }
}
