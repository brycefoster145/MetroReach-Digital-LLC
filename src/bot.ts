/**
 * MetroReach Digital — Telegram Bot
 *
 * Interactive bot for the owner to monitor the business.
 * Commands: /start /help /status /leads /revenue /calls /appointments
 * Also supports proactive notifications from other services.
 *
 * Polls Telegram API every 5 seconds via long-polling.
 */

// ── Path setup: run from metroreach-repo so db-v2 deps resolve ──
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Set DATABASE_URL from shared env
process.env.DATABASE_URL = process.env.DATABASE_URL || "";

// ── DB imports (relative to metroreach-repo src/) ──
const DB_PATH = path.join(__dirname, "..", "metroreach-repo", "src", "db-v2.ts");

// Lazy-loaded DB functions (initialized in main)
let initDb: Function;
let getAllTenants: Function;
let getLeads: Function;
let getCalls: Function;
let getAppointments: Function;

async function loadDb() {
  const db = await import(DB_PATH);
  initDb = db.initDb;
  getAllTenants = db.getAllTenants;
  getLeads = db.getLeads;
  getCalls = db.getCalls;
  getAppointments = db.getAppointments;
}

// ── Config ──────────────────────────────────────────────────
const BOT_TOKEN = "8891223174:AAGH1m-iYkGfsce8cW_cq7DxkqO7X1qvOEI";
const OWNER_CHAT_ID = 7977291523;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_INTERVAL_MS = 5000;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";

// ── Types ───────────────────────────────────────────────────
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}
interface TgMessage {
  message_id: number;
  from: { id: number; first_name: string; username?: string };
  chat: { id: number };
  text?: string;
  date: number;
}

// ── State ───────────────────────────────────────────────────
let lastUpdateId = 0;
let knownChatIds = new Set<number>([OWNER_CHAT_ID]);

// ── Telegram API helpers ────────────────────────────────────
async function tgCall(method: string, body: Record<string, unknown>): Promise<unknown> {
  const url = `${TELEGRAM_API}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(chatId: number, text: string, parseMode = "HTML"): Promise<void> {
  // Telegram max message length is 4096; split if needed
  if (text.length > 4000) {
    const chunks = text.match(/[\s\S]{1,4000}/g) || [text];
    for (const chunk of chunks) {
      await tgCall("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: parseMode,
      });
    }
  } else {
    await tgCall("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  }
}

// ── Stripe helper ───────────────────────────────────────────
async function getStripeRevenue(): Promise<string> {
  if (!STRIPE_KEY) {
    return "⚠️ Stripe API key not configured. Set STRIPE_SECRET_KEY to enable revenue tracking.";
  }

  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  try {
    // Fetch balance transactions or charges
    const res = await fetch(
      `https://api.stripe.com/v1/balance_transactions?created[gte]=${thirtyDaysAgo}&limit=100`,
      {
        headers: {
          Authorization: `Bearer ${STRIPE_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    const data = await res.json() as { data?: Array<{ amount: number; net: number; type: string }>; error?: { message: string } };

    if (data.error) {
      return `⚠️ Stripe error: ${data.error.message}`;
    }
    if (!data.data || data.data.length === 0) {
      return `💳 <b>Revenue (Last 30 Days)</b>\n\nNo transactions found.`;
    }

    let totalGross = 0;
    let totalNet = 0;
    let chargeCount = 0;
    for (const tx of data.data) {
      if (tx.type === "charge") {
        totalGross += tx.amount;
        totalNet += tx.net;
        chargeCount++;
      }
    }

    const formatUSD = (cents: number) => `$${(cents / 100).toFixed(2)}`;

    return [
      `💳 <b>Revenue (Last 30 Days)</b>`,
      ``,
      `📊 Transactions: <b>${chargeCount}</b>`,
      `💰 Gross: <b>${formatUSD(totalGross)}</b>`,
      `💵 Net: <b>${formatUSD(totalNet)}</b>`,
      `📉 Fees: <b>${formatUSD(totalGross - totalNet)}</b>`,
    ].join("\n");
  } catch (err: unknown) {
    return `⚠️ Failed to fetch Stripe data: ${err instanceof Error ? err.message : "Unknown error"}`;
  }
}

// ── Command handlers ────────────────────────────────────────

function cmdStart(): string {
  return [
    `🤖 <b>MetroReach Digital Bot</b>`,
    ``,
    `Welcome! I'm your autonomous business assistant. Here's what I can do:`,
    ``,
    `/status — Business overview (leads, calls, active tenants)`,
    `/leads — Recent leads captured`,
    `/revenue — Stripe revenue (last 30 days)`,
    `/calls — Recent call activity`,
    `/appointments — Upcoming appointments`,
    `/help — Show this list`,
    ``,
    `I'll also send proactive alerts for new leads, closed deals, and system events.`,
  ].join("\n");
}

function cmdHelp(): string {
  return [
    `📋 <b>Available Commands</b>`,
    ``,
    `/start — Welcome message`,
    `/status — Business overview`,
    `/leads — Recent leads`,
    `/revenue — Stripe revenue (30d)`,
    `/calls — Recent calls`,
    `/appointments — Upcoming appointments`,
    `/help — This list`,
  ].join("\n");
}

async function cmdStatus(): Promise<string> {
  const tenants = await getAllTenants();
  const tenantIds = tenants.map((t: { id: string }) => t.id);

  let totalLeads = 0;
  let totalCalls = 0;
  let totalAppointments = 0;

  for (const tid of tenantIds) {
    const leads = await getLeads(tid);
    const calls = await getCalls(tid);
    const apps = await getAppointments(tid);
    totalLeads += leads.length;
    totalCalls += calls.length;
    totalAppointments += apps.length;
  }

  const tenantList = tenants
    .map((t: { name: string; slug: string; phone_number?: string }, i: number) =>
      `  ${i + 1}. <b>${t.name}</b> (${t.slug}) ${t.phone_number ? "📞 " + t.phone_number : ""}`,
    )
    .join("\n");

  return [
    `📊 <b>MetroReach Digital — Status</b>`,
    ``,
    `🏢 <b>Active Tenants:</b> ${tenants.length}`,
    tenantList || "  (none)",
    ``,
    `📈 <b>Overview:</b>`,
    `  👤 Leads captured: <b>${totalLeads}</b>`,
    `  📞 Calls handled: <b>${totalCalls}</b>`,
    `  📅 Appointments: <b>${totalAppointments}</b>`,
    ``,
    `🤖 <b>Services:</b>`,
    `  ✅ AI Website Assistant ($99/mo)`,
    `  ✅ Basic Website ($299)`,
    `  🔄 AI Phone Receptionist (Phase 1)`,
  ].join("\n");
}

async function cmdLeads(): Promise<string> {
  const tenants = await getAllTenants();
  const allLeads: Array<{ name: string; email: string; phone: string; source: string; created_at: string; tenant_id: string }> = [];
  const tenantMap = new Map<string, string>();
  for (const t of tenants as Array<{ id: string; name: string }>) {
    tenantMap.set(t.id, t.name);
  }

  for (const t of tenants as Array<{ id: string }>) {
    const leads = await getLeads(t.id) as Array<{ name: string; email: string; phone: string; source: string; created_at: string; tenant_id: string }>;
    allLeads.push(...leads);
  }

  // Sort by created_at desc, take last 15
  allLeads.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const recent = allLeads.slice(0, 15);

  if (recent.length === 0) {
    return `👤 <b>Recent Leads</b>\n\nNo leads captured yet.`;
  }

  const lines = recent.map((l, i) => {
    const tenant = tenantMap.get(l.tenant_id) || l.tenant_id;
    const date = l.created_at ? new Date(l.created_at).toLocaleDateString() : "?";
    const name = l.name || "Anonymous";
    const contact = [l.phone, l.email].filter(Boolean).join(" / ") || "no contact";
    return `  ${i + 1}. <b>${name}</b> — ${contact}\n     🏢 ${tenant} | 📅 ${date} | via ${l.source || "?"}`;
  });

  return [`👤 <b>Recent Leads</b> (last ${recent.length})`, "", ...lines].join("\n");
}

async function cmdCalls(): Promise<string> {
  const tenants = await getAllTenants();
  const allCalls: Array<{ from_number: string; to_number: string; duration: number; outcome: string; summary: string; created_at: string; tenant_id: string }> = [];
  const tenantMap = new Map<string, string>();
  for (const t of tenants as Array<{ id: string; name: string }>) {
    tenantMap.set(t.id, t.name);
  }

  for (const t of tenants as Array<{ id: string }>) {
    const calls = await getCalls(t.id) as Array<{ from_number: string; to_number: string; duration: number; outcome: string; summary: string; created_at: string; tenant_id: string }>;
    allCalls.push(...calls);
  }

  allCalls.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const recent = allCalls.slice(0, 15);

  if (recent.length === 0) {
    return `📞 <b>Recent Calls</b>\n\nNo calls recorded yet.`;
  }

  const lines = recent.map((c, i) => {
    const tenant = tenantMap.get(c.tenant_id) || c.tenant_id;
    const date = c.created_at ? new Date(c.created_at).toLocaleDateString() : "?";
    const dur = c.duration ? `${Math.round(c.duration / 60)}m` : "?";
    const summary = c.summary ? ` — ${c.summary.slice(0, 60)}` : "";
    return `  ${i + 1}. 📞 ${c.from_number} → ${c.to_number} (${dur})\n     🏢 ${tenant} | ${c.outcome || "completed"} | 📅 ${date}${summary}`;
  });

  return [`📞 <b>Recent Calls</b> (last ${recent.length})`, "", ...lines].join("\n");
}

async function cmdAppointments(): Promise<string> {
  const tenants = await getAllTenants();
  const allAppts: Array<{ caller_name: string; start_time: string; end_time: string; status: string; staff_name: string; tenant_id: string }> = [];
  const tenantMap = new Map<string, string>();
  for (const t of tenants as Array<{ id: string; name: string }>) {
    tenantMap.set(t.id, t.name);
  }

  const now = new Date().toISOString();
  for (const t of tenants as Array<{ id: string }>) {
    const appts = await getAppointments(t.id, now) as Array<{ caller_name: string; start_time: string; end_time: string; status: string; staff_name: string; tenant_id: string }>;
    allAppts.push(...appts);
  }

  allAppts.sort((a, b) => a.start_time.localeCompare(b.start_time));
  const upcoming = allAppts.slice(0, 15);

  if (upcoming.length === 0) {
    return `📅 <b>Upcoming Appointments</b>\n\nNo upcoming appointments.`;
  }

  const lines = upcoming.map((a, i) => {
    const tenant = tenantMap.get(a.tenant_id) || a.tenant_id;
    const date = new Date(a.start_time).toLocaleString();
    const name = a.caller_name || "Unknown";
    const staff = a.staff_name ? ` with ${a.staff_name}` : "";
    const status = a.status === "confirmed" ? "✅" : a.status === "cancelled" ? "❌" : "⏳";
    return `  ${i + 1}. ${status} <b>${name}</b>${staff}\n     📍 ${tenant} | 🕐 ${date}`;
  });

  return [`📅 <b>Upcoming Appointments</b> (next ${upcoming.length})`, "", ...lines].join("\n");
}

// ── Command router ──────────────────────────────────────────
async function handleCommand(cmd: string, chatId: number): Promise<string> {
  switch (cmd) {
    case "/start":     return cmdStart();
    case "/help":      return cmdHelp();
    case "/status":
    case "/update":    return await cmdStatus();
    case "/leads":     return await cmdLeads();
    case "/revenue":   return await getStripeRevenue();
    case "/calls":     return await cmdCalls();
    case "/appointments": return await cmdAppointments();
    default:
      return `Unknown command: ${cmd}\nType /help for available commands.`;
  }
}

// ── Polling loop ────────────────────────────────────────────
async function poll(): Promise<void> {
  try {
    const params = new URLSearchParams({
      offset: String(lastUpdateId + 1),
      timeout: "25", // long-polling timeout (seconds)
      allowed_updates: JSON.stringify(["message"]),
    });

    const res = await fetch(`${TELEGRAM_API}/getUpdates?${params}`);
    const data = await res.json() as { ok: boolean; result?: TgUpdate[] };

    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      const msg = update.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      knownChatIds.add(chatId);

      // Only respond to commands
      if (msg.text.startsWith("/")) {
        const cmd = msg.text.split(" ")[0].split("@")[0]; // strip @botname
        const response = await handleCommand(cmd, chatId);
        await sendMessage(chatId, response);
        console.log(`[bot] ${cmd} from ${msg.from.first_name} (${chatId})`);
      }
    }
  } catch (err) {
    // Network errors during polling are normal; log and continue
    if (!(err instanceof Error && err.message.includes("fetch failed"))) {
      console.error("[bot] poll error:", err);
    }
  }
}

// ── Proactive notification (exported for other services) ────
export async function notifyOwner(message: string): Promise<void> {
  await sendMessage(OWNER_CHAT_ID, `🔔 <b>Proactive Alert</b>\n\n${message}`);
}

export async function notifyAll(message: string): Promise<void> {
  for (const chatId of knownChatIds) {
    await sendMessage(chatId, `🔔 <b>MetroReach Alert</b>\n\n${message}`);
  }
}

// ── Main ────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("🤖 MetroReach Telegram Bot starting...");

  // Ensure DATABASE_URL is set (read from metroreach .env if not)
  if (!process.env.DATABASE_URL) {
    // Try loading from shared env file
    const envPath = path.join(__dirname, "..", ".env.receptionist");
    try {
      const fs = await import("node:fs");
      const envContent = await fs.promises.readFile(envPath, "utf-8");
      for (const line of envContent.split("\n")) {
        const [key, ...vals] = line.split("=");
        if (key && vals.length && !process.env[key.trim()]) {
          process.env[key.trim()] = vals.join("=").trim();
        }
      }
    } catch {
      // .env file not found; db-v2 will fall back to SQLite
    }
  }

  // Load DB module (avoids top-level await)
  await loadDb();

  // Init DB
  await initDb();
  console.log("[bot] Database ready");

  // Poll forever
  console.log(`[bot] Polling every ${POLL_INTERVAL_MS / 1000}s...`);
  while (true) {
    await poll();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error("[bot] Fatal error:", err);
  process.exit(1);
});
