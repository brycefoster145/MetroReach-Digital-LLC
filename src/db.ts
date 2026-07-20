/**
 * Phase 1 Database Layer — Postgres (Neon) with SQLite fallback
 * 
 * Multi-tenant schema:
 *   tenants — business configs with knowledge base, routing rules, calendar settings
 *   departments — per-tenant routing groups
 *   appointments — booked slots with calendar sync
 *   leads — captured leads from chat/voice
 *   calls — call recordings and transcripts
 */

import { neon, neonConfig } from "@neondatabase/serverless";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = path.join(__dirname, "..", "receptionist.db");

// ── Driver selection ──────────────────────────────────────
let pg: ReturnType<typeof neon> | null = null;
let sqliteDb: Database.Database | null = null;

function hasPostgres(): boolean {
  const url = process.env.DATABASE_URL;
  return !!(url && url.startsWith("postgres"));
}

function getPg() {
  if (!pg) {
    neonConfig.fetchConnectionCache = true;
    pg = neon(process.env.DATABASE_URL!);
  }
  return pg;
}

function getSqlite(): Database.Database {
  if (!sqliteDb) {
    sqliteDb = new Database(SQLITE_PATH);
    sqliteDb.pragma("journal_mode = WAL");
    sqliteDb.pragma("foreign_keys = ON");
  }
  return sqliteDb;
}

// ── Unified query interface ──────────────────────────────
async function query(sql: string, params: any[] = []): Promise<any[]> {
  if (hasPostgres()) {
    // Convert SQLite-style ? to Postgres $1, $2, ...
    let pgSql = sql;
    let paramIdx = 1;
    pgSql = pgSql.replace(/\?/g, () => "$" + paramIdx++);
    // Convert SQLite-isms to Postgres
    pgSql = pgSql.replace(/datetime\('now'\)/gi, "CURRENT_TIMESTAMP");
    pgSql = pgSql.replace(/INSERT OR REPLACE INTO/gi, "INSERT INTO");
    const result = await getPg().query(pgSql, params);
    return result as any[];
  } else {
    const db = getSqlite();
    const stmt = db.prepare(sql);
    if (sql.trim().toUpperCase().startsWith("SELECT") || sql.trim().toUpperCase().startsWith("WITH")) {
      return stmt.all(...params);
    } else {
      stmt.run(...params);
      return [];
    }
  }
}

async function queryOne(sql: string, params: any[] = []): Promise<any | undefined> {
  const rows = await query(sql, params);
  return rows[0];
}

// ── Schema initialization ────────────────────────────────
export async function initDb(): Promise<void> {
  // Tenants
  await query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      primary_color TEXT DEFAULT 'indigo',
      knowledge TEXT DEFAULT '{}',
      routing_rules TEXT DEFAULT '{}',
      calendar_config TEXT DEFAULT '{}',
      phone_number TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Departments (IVR routing)
  await query(`
    CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      prompt TEXT,
      keypress TEXT,
      order_index INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // Appointments
  await query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      caller_name TEXT,
      caller_phone TEXT,
      caller_email TEXT,
      staff_name TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      status TEXT DEFAULT 'confirmed',
      calendar_event_id TEXT,
      calendar_provider TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_appts_tenant ON appointments(tenant_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_appts_time ON appointments(start_time, end_time)`);

  // Leads
  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      question TEXT DEFAULT '',
      source TEXT DEFAULT 'chat',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id)`);

  // Calls (recordings)
  await query(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      call_sid TEXT,
      from_number TEXT,
      to_number TEXT,
      duration INTEGER DEFAULT 0,
      recording_url TEXT,
      transcript TEXT,
      summary TEXT,
      outcome TEXT DEFAULT 'completed',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_calls_tenant ON calls(tenant_id)`);

  // Phase 2 — Caller profiles (memory)
  await query(`
    CREATE TABLE IF NOT EXISTS caller_profiles (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      name TEXT,
      email TEXT,
      total_calls INTEGER DEFAULT 1,
      last_call_at TEXT DEFAULT (datetime('now')),
      tags TEXT DEFAULT '[]',
      notes TEXT DEFAULT '',
      preferred_contact TEXT DEFAULT 'phone',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      UNIQUE(tenant_id, phone_number)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_caller_profile_phone ON caller_profiles(tenant_id, phone_number)`);

  // Phase 2 — Lead scores
  await query(`
    CREATE TABLE IF NOT EXISTS lead_scores (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      caller_profile_id TEXT,
      score INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'cold',
      factors TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // Phase 2 — Sentiment logs
  await query(`
    CREATE TABLE IF NOT EXISTS sentiment_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      call_id TEXT,
      segment_text TEXT,
      sentiment TEXT DEFAULT 'neutral',
      score REAL DEFAULT 0.0,
      detected_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // Phase 3 — Messages (SMS, email, WhatsApp)
  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      recipient TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'sms',
      direction TEXT NOT NULL DEFAULT 'outbound',
      body TEXT NOT NULL,
      status TEXT DEFAULT 'sent',
      external_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id)`);

  // Phase 3 — Payment intents
  await query(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      stripe_pi_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      status TEXT DEFAULT 'pending',
      customer_email TEXT,
      customer_name TEXT,
      description TEXT,
      metadata TEXT DEFAULT '{}',
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  // Phase 3 — Workflows
  await query(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      trigger_event TEXT NOT NULL,
      conditions TEXT DEFAULT '{}',
      actions TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      trigger_data TEXT DEFAULT '{}',
      status TEXT DEFAULT 'completed',
      results TEXT DEFAULT '[]',
      run_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    )
  `);

  console.log(`✅ Database initialized (${hasPostgres() ? "Postgres" : "SQLite"}) [Phase 2&3]`);
}

// ── Tenant queries ───────────────────────────────────────
export async function getTenantBySlug(slug: string) {
  return queryOne("SELECT * FROM tenants WHERE slug = ?", [slug]);
}

export async function getTenantById(id: string) {
  return queryOne("SELECT * FROM tenants WHERE id = ?", [id]);
}

export async function getAllTenants() {
  return query("SELECT * FROM tenants ORDER BY created_at DESC");
}

export async function upsertTenant(tenant: {
  id: string;
  name: string;
  slug: string;
  primary_color?: string;
  knowledge?: string;
  routing_rules?: string;
  calendar_config?: string;
  phone_number?: string;
}) {
  const existing = await getTenantById(tenant.id);
  if (existing) {
    await query(
      `UPDATE tenants SET name=?, slug=?, primary_color=?, knowledge=?, routing_rules=?, calendar_config=?, phone_number=?, updated_at=datetime('now') WHERE id=?`,
      [tenant.name, tenant.slug, tenant.primary_color || existing.primary_color, tenant.knowledge || existing.knowledge, tenant.routing_rules || existing.routing_rules, tenant.calendar_config || existing.calendar_config, tenant.phone_number || existing.phone_number, tenant.id],
    );
  } else {
    await query(
      `INSERT INTO tenants (id, name, slug, primary_color, knowledge, routing_rules, calendar_config, phone_number) VALUES (?,?,?,?,?,?,?,?)`,
      [tenant.id, tenant.name, tenant.slug, tenant.primary_color || "indigo", tenant.knowledge || "{}", tenant.routing_rules || "{}", tenant.calendar_config || "{}", tenant.phone_number || null],
    );
  }
  return getTenantById(tenant.id);
}

// ── Department queries ───────────────────────────────────
export async function getDepartments(tenantId: string) {
  return query("SELECT * FROM departments WHERE tenant_id = ? ORDER BY order_index", [tenantId]);
}

export async function upsertDepartment(dept: {
  id: string;
  tenant_id: string;
  name: string;
  phone?: string;
  prompt?: string;
  keypress?: string;
  order_index?: number;
}) {
  await query(
    `INSERT OR REPLACE INTO departments (id, tenant_id, name, phone, prompt, keypress, order_index, created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`,
    [dept.id, dept.tenant_id, dept.name, dept.phone || null, dept.prompt || null, dept.keypress || null, dept.order_index || 0],
  );
  return queryOne("SELECT * FROM departments WHERE id = ?", [dept.id]);
}

// ── Appointment queries ──────────────────────────────────
export async function checkAvailability(tenantId: string, startTime: string, endTime: string): Promise<boolean> {
  const conflicts = await query(
    `SELECT COUNT(*) as count FROM appointments WHERE tenant_id = ? AND status != 'cancelled' AND start_time < ? AND end_time > ?`,
    [tenantId, endTime, startTime],
  );
  return (conflicts[0]?.count || 0) === 0;
}

export async function createAppointment(appt: {
  id: string;
  tenant_id: string;
  caller_name?: string;
  caller_phone?: string;
  caller_email?: string;
  staff_name?: string;
  start_time: string;
  end_time: string;
  notes?: string;
}) {
  // Double-booking check
  const available = await checkAvailability(appt.tenant_id, appt.start_time, appt.end_time);
  if (!available) {
    throw new Error("Time slot not available");
  }

  await query(
    `INSERT INTO appointments (id, tenant_id, caller_name, caller_phone, caller_email, staff_name, start_time, end_time, notes) VALUES (?,?,?,?,?,?,?,?,?)`,
    [appt.id, appt.tenant_id, appt.caller_name || null, appt.caller_phone || null, appt.caller_email || null, appt.staff_name || null, appt.start_time, appt.end_time, appt.notes || null],
  );
  return queryOne("SELECT * FROM appointments WHERE id = ?", [appt.id]);
}

export async function updateAppointment(id: string, updates: {
  start_time?: string;
  end_time?: string;
  status?: string;
  notes?: string;
  calendar_event_id?: string;
  calendar_provider?: string;
}) {
  const existing = await queryOne("SELECT * FROM appointments WHERE id = ?", [id]);
  if (!existing) throw new Error("Appointment not found");

  const newStart = updates.start_time || existing.start_time;
  const newEnd = updates.end_time || existing.end_time;

  // Check availability for rescheduling (exclude self)
  if (updates.start_time || updates.end_time) {
    const conflicts = await query(
      `SELECT COUNT(*) as count FROM appointments WHERE tenant_id = ? AND id != ? AND status != 'cancelled' AND start_time < ? AND end_time > ?`,
      [existing.tenant_id, id, newEnd, newStart],
    );
    if ((conflicts[0]?.count || 0) > 0) {
      throw new Error("New time slot not available");
    }
  }

  await query(
    `UPDATE appointments SET start_time=?, end_time=?, status=?, notes=?, calendar_event_id=?, calendar_provider=?, updated_at=datetime('now') WHERE id=?`,
    [newStart, newEnd, updates.status || existing.status, updates.notes || existing.notes, updates.calendar_event_id || existing.calendar_event_id, updates.calendar_provider || existing.calendar_provider, id],
  );
  return queryOne("SELECT * FROM appointments WHERE id = ?", [id]);
}

export async function getAppointments(tenantId: string, dateFrom?: string, dateTo?: string) {
  let sql = "SELECT * FROM appointments WHERE tenant_id = ?";
  const params: any[] = [tenantId];
  if (dateFrom) { sql += " AND start_time >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND start_time <= ?"; params.push(dateTo); }
  sql += " ORDER BY start_time";
  return query(sql, params);
}

// ── Lead queries ─────────────────────────────────────────
export async function saveLead(lead: {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string;
  question: string;
  source?: string;
}) {
  await query(
    `INSERT INTO leads (id, tenant_id, name, email, phone, question, source) VALUES (?,?,?,?,?,?,?)`,
    [lead.id, lead.tenant_id, lead.name, lead.email, lead.phone, lead.question, lead.source || "voice"],
  );
  return queryOne("SELECT * FROM leads WHERE id = ?", [lead.id]);
}

export async function getLeads(tenantId: string) {
  return query("SELECT * FROM leads WHERE tenant_id = ? ORDER BY created_at DESC", [tenantId]);
}

// ── Call recording queries ───────────────────────────────
export async function saveCall(call: {
  id: string;
  tenant_id: string;
  call_sid: string;
  from_number: string;
  to_number: string;
  duration?: number;
  recording_url?: string;
  transcript?: string;
  summary?: string;
  outcome?: string;
}) {
  await query(
    `INSERT INTO calls (id, tenant_id, call_sid, from_number, to_number, duration, recording_url, transcript, summary, outcome) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [call.id, call.tenant_id, call.call_sid, call.from_number, call.to_number, call.duration || 0, call.recording_url || null, call.transcript || null, call.summary || null, call.outcome || "completed"],
  );
  return queryOne("SELECT * FROM calls WHERE id = ?", [call.id]);
}

export async function getCalls(tenantId: string) {
  return query("SELECT * FROM calls WHERE tenant_id = ? ORDER BY created_at DESC", [tenantId]);
}

// ── Phase 2: Caller Profile queries ──────────────────────
export async function getCallerProfile(tenantId: string, phoneNumber: string) {
  return queryOne("SELECT * FROM caller_profiles WHERE tenant_id = ? AND phone_number = ?", [tenantId, phoneNumber]);
}

export async function upsertCallerProfile(profile: {
  id: string;
  tenant_id: string;
  phone_number: string;
  name?: string;
  email?: string;
  tags?: string;
  notes?: string;
}) {
  const existing = await getCallerProfile(profile.tenant_id, profile.phone_number);
  if (existing) {
    await query(
      `UPDATE caller_profiles SET name=COALESCE(?,name), email=COALESCE(?,email), total_calls=total_calls+1, last_call_at=datetime('now'), tags=COALESCE(?,tags), notes=COALESCE(?,notes), updated_at=datetime('now') WHERE id=?`,
      [profile.name || null, profile.email || null, profile.tags || null, profile.notes || null, existing.id],
    );
    return queryOne("SELECT * FROM caller_profiles WHERE id = ?", [existing.id]);
  }
  await query(
    `INSERT INTO caller_profiles (id, tenant_id, phone_number, name, email, tags, notes) VALUES (?,?,?,?,?,?,?)`,
    [profile.id, profile.tenant_id, profile.phone_number, profile.name || null, profile.email || null, profile.tags || "[]", profile.notes || ""],
  );
  return queryOne("SELECT * FROM caller_profiles WHERE id = ?", [profile.id]);
}

export async function getCallerCalls(tenantId: string, phoneNumber: string) {
  return query("SELECT * FROM calls WHERE tenant_id = ? AND from_number = ? ORDER BY created_at DESC LIMIT 20", [tenantId, phoneNumber]);
}

// ── Phase 2: Lead Scoring queries ────────────────────────
export async function saveLeadScore(score: {
  id: string;
  tenant_id: string;
  lead_id?: string;
  caller_profile_id?: string;
  score: number;
  tier: string;
  factors: string;
}) {
  await query(
    `INSERT INTO lead_scores (id, tenant_id, lead_id, caller_profile_id, score, tier, factors) VALUES (?,?,?,?,?,?,?)`,
    [score.id, score.tenant_id, score.lead_id || null, score.caller_profile_id || null, score.score, score.tier, score.factors],
  );
  return queryOne("SELECT * FROM lead_scores WHERE id = ?", [score.id]);
}

export async function getLeadScores(tenantId: string) {
  return query("SELECT * FROM lead_scores WHERE tenant_id = ? ORDER BY score DESC", [tenantId]);
}

// ── Phase 2: Sentiment queries ───────────────────────────
export async function saveSentimentLog(entry: {
  id: string;
  tenant_id: string;
  call_id?: string;
  segment_text: string;
  sentiment: string;
  score: number;
}) {
  await query(
    `INSERT INTO sentiment_logs (id, tenant_id, call_id, segment_text, sentiment, score) VALUES (?,?,?,?,?,?)`,
    [entry.id, entry.tenant_id, entry.call_id || null, entry.segment_text, entry.sentiment, entry.score],
  );
}

export async function getCallSentiment(callId: string) {
  return query("SELECT * FROM sentiment_logs WHERE call_id = ? ORDER BY detected_at", [callId]);
}

// ── Phase 3: Messages queries ────────────────────────────
export async function saveMessage(msg: {
  id: string;
  tenant_id: string;
  recipient: string;
  channel: string;
  direction: string;
  body: string;
  status?: string;
  external_id?: string;
  metadata?: string;
}) {
  await query(
    `INSERT INTO messages (id, tenant_id, recipient, channel, direction, body, status, external_id, metadata) VALUES (?,?,?,?,?,?,?,?,?)`,
    [msg.id, msg.tenant_id, msg.recipient, msg.channel, msg.direction, msg.body, msg.status || "sent", msg.external_id || null, msg.metadata || "{}"],
  );
  return queryOne("SELECT * FROM messages WHERE id = ?", [msg.id]);
}

export async function getMessages(tenantId: string, limit = 50) {
  return query("SELECT * FROM messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?", [tenantId, limit]);
}

// ── Phase 3: Payment queries ─────────────────────────────
export async function createPaymentIntent(pi: {
  id: string;
  tenant_id: string;
  stripe_pi_id?: string;
  amount: number;
  currency?: string;
  customer_email?: string;
  customer_name?: string;
  description?: string;
  metadata?: string;
}) {
  await query(
    `INSERT INTO payment_intents (id, tenant_id, stripe_pi_id, amount, currency, customer_email, customer_name, description, metadata) VALUES (?,?,?,?,?,?,?,?,?)`,
    [pi.id, pi.tenant_id, pi.stripe_pi_id || null, pi.amount, pi.currency || "usd", pi.customer_email || null, pi.customer_name || null, pi.description || null, pi.metadata || "{}"],
  );
  return queryOne("SELECT * FROM payment_intents WHERE id = ?", [pi.id]);
}

export async function updatePaymentIntent(id: string, updates: { stripe_pi_id?: string; status?: string; completed_at?: string }) {
  await query(
    `UPDATE payment_intents SET stripe_pi_id=COALESCE(?,stripe_pi_id), status=COALESCE(?,status), completed_at=COALESCE(?,completed_at) WHERE id=?`,
    [updates.stripe_pi_id || null, updates.status || null, updates.completed_at || null, id],
  );
  return queryOne("SELECT * FROM payment_intents WHERE id = ?", [id]);
}

export async function getPaymentIntents(tenantId: string) {
  return query("SELECT * FROM payment_intents WHERE tenant_id = ? ORDER BY created_at DESC", [tenantId]);
}

// ── Phase 3: Workflow queries ────────────────────────────
export async function createWorkflow(wf: {
  id: string;
  tenant_id: string;
  name: string;
  trigger_event: string;
  conditions?: string;
  actions: string;
}) {
  await query(
    `INSERT INTO workflows (id, tenant_id, name, trigger_event, conditions, actions) VALUES (?,?,?,?,?,?)`,
    [wf.id, wf.tenant_id, wf.name, wf.trigger_event, wf.conditions || "{}", wf.actions],
  );
  return queryOne("SELECT * FROM workflows WHERE id = ?", [wf.id]);
}

export async function getWorkflows(tenantId: string) {
  return query("SELECT * FROM workflows WHERE tenant_id = ? AND enabled = 1 ORDER BY created_at", [tenantId]);
}

export async function getWorkflowsByTrigger(tenantId: string, event: string) {
  return query("SELECT * FROM workflows WHERE tenant_id = ? AND trigger_event = ? AND enabled = 1", [tenantId, event]);
}

export async function logWorkflowRun(run: {
  id: string;
  tenant_id: string;
  workflow_id: string;
  trigger_data?: string;
  status?: string;
  results?: string;
}) {
  await query(
    `INSERT INTO workflow_runs (id, tenant_id, workflow_id, trigger_data, status, results) VALUES (?,?,?,?,?,?)`,
    [run.id, run.tenant_id, run.workflow_id, run.trigger_data || "{}", run.status || "completed", run.results || "[]"],
  );
  return queryOne("SELECT * FROM workflow_runs WHERE id = ?", [run.id]);
}
