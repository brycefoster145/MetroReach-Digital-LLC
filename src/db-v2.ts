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

  console.log(`✅ Database initialized (${hasPostgres() ? "Postgres" : "SQLite"})`);
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
