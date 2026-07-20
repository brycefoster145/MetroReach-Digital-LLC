/**
 * Phase 3 — Stripe Payment Processing
 *
 * Creates payment intents, processes invoices, takes deposits.
 * Integrated with the Stripe API.
 */

import { randomUUID } from "node:crypto";
import { createPaymentIntent, updatePaymentIntent, getPaymentIntents } from "./db.js";

function getStripeKey(): string | null {
  return process.env.STRIPE_SECRET_KEY || null;
}

async function stripeRequest(endpoint: string, body: Record<string, unknown>): Promise<any> {
  const key = getStripeKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    params.append(k, String(v));
  }

  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  return res.json();
}

// ── Create payment intent ─────────────────────────────────
export async function createPayment(
  tenantId: string,
  params: {
    amount: number;        // in cents
    currency?: string;
    customerEmail?: string;
    customerName?: string;
    description?: string;
    metadata?: Record<string, string>;
  },
): Promise<{
  success: boolean;
  paymentId: string;
  clientSecret?: string;
  stripePiId?: string;
  error?: string;
}> {
  const paymentId = randomUUID();

  try {
    const key = getStripeKey();
    if (!key) {
      // Log locally, no Stripe
      await createPaymentIntent({
        id: paymentId,
        tenant_id: tenantId,
        amount: params.amount,
        currency: params.currency || "usd",
        customer_email: params.customerEmail,
        customer_name: params.customerName,
        description: params.description,
        metadata: JSON.stringify(params.metadata || {}),
      });
      return {
        success: false,
        paymentId,
        error: "STRIPE_SECRET_KEY not configured. Payment logged locally.",
      };
    }

    // Create Stripe PaymentIntent
    const stripeBody: Record<string, unknown> = {
      amount: params.amount,
      currency: params.currency || "usd",
      ...(params.description ? { description: params.description } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };

    if (params.customerEmail) {
      stripeBody["receipt_email"] = params.customerEmail;
    }

    const result = await stripeRequest("payment_intents", stripeBody);

    if (result.error) {
      await createPaymentIntent({
        id: paymentId,
        tenant_id: tenantId,
        amount: params.amount,
        customer_email: params.customerEmail,
        customer_name: params.customerName,
        description: params.description,
      });
      return { success: false, paymentId, error: result.error.message };
    }

    const stripePiId = result.id;

    await createPaymentIntent({
      id: paymentId,
      tenant_id: tenantId,
      stripe_pi_id: stripePiId,
      amount: params.amount,
      currency: params.currency || "usd",
      customer_email: params.customerEmail,
      customer_name: params.customerName,
      description: params.description,
      metadata: JSON.stringify(params.metadata || {}),
    });

    return {
      success: true,
      paymentId,
      clientSecret: result.client_secret,
      stripePiId,
    };
  } catch (err: any) {
    return { success: false, paymentId, error: err.message };
  }
}

// ── Confirm payment (check status) ────────────────────────
export async function checkPaymentStatus(stripePiId: string): Promise<{
  status: string;
  amount: number;
  completed: boolean;
}> {
  const key = getStripeKey();
  if (!key) return { status: "unknown", amount: 0, completed: false };

  try {
    const res = await fetch(`https://api.stripe.com/v1/payment_intents/${stripePiId}`, {
      headers: { "Authorization": `Bearer ${key}` },
    });
    const data = await res.json();

    const completed = data.status === "succeeded";

    if (completed) {
      // Update our DB
      await updatePaymentIntent(stripePiId, {
        status: "completed",
        completed_at: new Date().toISOString(),
      });
    }

    return {
      status: data.status,
      amount: data.amount,
      completed,
    };
  } catch {
    return { status: "error", amount: 0, completed: false };
  }
}

// ── Request deposit ───────────────────────────────────────
export async function requestDeposit(
  tenantId: string,
  customerEmail: string,
  customerName: string,
  totalAmount: number,
  depositPercent = 25,
  description = "Deposit",
): Promise<ReturnType<typeof createPayment>> {
  const depositAmount = Math.round(totalAmount * (depositPercent / 100));
  return createPayment(tenantId, {
    amount: depositAmount,
    customerEmail,
    customerName,
    description: `${description} (${depositPercent}% of $${(totalAmount / 100).toFixed(2)})`,
    metadata: { type: "deposit", totalAmount: String(totalAmount), depositPercent: String(depositPercent) },
  });
}

// ── Get payment history ───────────────────────────────────
export async function getPaymentHistory(tenantId: string) {
  return getPaymentIntents(tenantId);
}

// ── Build Stripe payment link ─────────────────────────────
export function buildStripePaymentUrl(
  clientSecret: string,
  returnUrl = "https://metroreach.digital/thank-you",
): string {
  return `https://checkout.stripe.com/pay/${clientSecret.split("_secret_")[0]}?client_secret=${encodeURIComponent(clientSecret)}`;
}
