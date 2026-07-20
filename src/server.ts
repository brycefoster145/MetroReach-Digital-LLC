/**
 * Phase 1 Server — Multi-tenant AI Phone Receptionist
 * 
 * New endpoints:
 *   POST /api/twilio/voice/ivr         — DTMF routing
 *   POST /api/twilio/voice/record-cb   — Recording status callback
 *   GET  /api/appointments/:slug       — List appointments
 *   POST /api/appointments/:slug       — Book appointment
 *   PUT  /api/appointments/:id         — Reschedule/cancel
 *   GET  /api/leads/:slug              — List leads
 *   GET  /api/calls/:slug              — Call history
 *   POST /api/admin/departments        — Manage IVR departments
 *   PUT  /api/admin/tenants/:id        — Update tenant config
 */

import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  initDb, getTenantBySlug, getTenantById, getAllTenants, upsertTenant,
  getDepartments, upsertDepartment, getAppointments, getLeads,
  createAppointment, updateAppointment, getCalls, saveCall,
  getCallerProfile, getLeadScores, getPaymentIntents,
  getWorkflows, getMessages, createWorkflow,
} from "./db.js";
import { chat, captureLead } from "./agent.js";
import {
  handleIncomingCall, handleSpeechResponse, handleLeadCapture,
  handleIVR, handleRecordingCallback,
} from "./voice.js";
import { bookAppointment, rescheduleAppointment, cancelAppointment } from "./appointments.js";
import { recognizeCaller, tagCaller } from "./memory.js";
import { scoreLead, getTopLeads } from "./scoring.js";
import { analyzeCallSentiment, getCallSentimentSummary } from "./sentiment.js";
import { findContact, logCallToCrm } from "./crm.js";
import { sendSms } from "./sms.js";
import { sendEmail, sendInvoice } from "./email.js";
import { createPayment, checkPaymentStatus, requestDeposit } from "./payments.js";
import { postCallFollowUp, paymentFollowUpSequence } from "./followups.js";
import { fireTrigger, WORKFLOW_TEMPLATES } from "./workflows.js";
import { getDashboard, getQuickStats, getCustomerSatisfaction } from "./analytics.js";
import { recordAudit, getAuditTrail, getComplianceStatus, generateConsentTwiml } from "./compliance.js";
import { synthesizeSpeech, PERSONA_TEMPLATES, detectLanguage, translateResponse } from "./premium.js";
import { sendWhatsApp, sendFacebookMessage, sendInstagramMessage } from "./channels.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.RECEPTIONIST_PORT || "3001", 10);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Init ──────────────────────────────────────────────
(async () => {
  await initDb();

  // Seed demo
  const tenants = await getAllTenants();
  if (tenants.length === 0) {
    const demoId = randomUUID();
    await upsertTenant({
      id: demoId,
      name: "Demo Business",
      slug: "demo",
      primary_color: "indigo",
      knowledge: JSON.stringify({
        businessName: "Demo Business",
        description: "A friendly local business.",
        hours: "Mon–Fri: 9am–6pm, Sat: 10am–4pm, Sun: Closed",
        phone: "(555) 123-4567",
        email: "hello@demo.com",
        address: "123 Main St, Anytown, USA",
        services: ["Consulting", "Support", "Sales"],
      }),
    });
    console.log("✅ Seeded demo tenant");
  }
})();

// ── Chat widget endpoints (unchanged) ─────────────────
app.post("/api/chat/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const { message, history } = req.body;
    const business = await getTenantBySlug(slug);
    if (!business) { res.status(404).json({ error: "Not found" }); return; }
    const result = await chat(slug, message, history || []);
    res.json(result);
  } catch (e: any) { res.json({ reply: "Sorry, try again.", captureLead: true }); }
});

app.post("/api/leads/:slug", async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await captureLead(slug, req.body);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── Widget ────────────────────────────────────────────
app.get("/widget/:slug.js", async (req, res) => {
  const { slug } = req.params;
  const business = await getTenantBySlug(slug);
  if (!business) { res.status(404).send("// Not found"); return; }

  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=3600");

  const widgetPath = path.join(__dirname, "widget", "widget.js");
  if (!existsSync(widgetPath)) { res.status(500).send("// Widget missing"); return; }

  let widget = readFileSync(widgetPath, "utf8");
  widget = widget
    .replace("__BUSINESS_SLUG__", slug)
    .replace("__BUSINESS_NAME__", business.name)
    .replace("__PRIMARY_COLOR__", business.primary_color || "indigo")
    .replace("__API_BASE__", "");
  res.send(widget);
});

// ── Twilio Voice endpoints ────────────────────────────
app.post("/api/twilio/voice", async (req, res) => {
  const slug = (req.query.slug as string) || "demo";
  const from = req.body?.From || "";
  const twiml = await handleIncomingCall(slug, from);
  res.type("text/xml").send(twiml);
});

app.post("/api/twilio/voice/ivr", async (req, res) => {
  const slug = (req.query.slug as string) || "demo";
  const digits = req.body?.Digits || "";
  const twiml = await handleIVR(slug, digits);
  res.type("text/xml").send(twiml);
});

app.post("/api/twilio/voice/respond", async (req, res) => {
  const slug = (req.query.slug as string) || "demo";
  const dept = req.query.dept as string | undefined;
  const speechResult = req.body?.SpeechResult || "";
  const callSid = req.body?.CallSid || "";
  const from = req.body?.From || "";
  const twiml = await handleSpeechResponse(slug, speechResult, callSid, dept, from);
  res.type("text/xml").send(twiml);
});

app.post("/api/twilio/voice/capture", async (req, res) => {
  const slug = (req.query.slug as string) || "demo";
  const speechResult = req.body?.SpeechResult || "";
  const from = req.body?.From || "";
  const twiml = await handleLeadCapture(slug, speechResult, from);
  res.type("text/xml").send(twiml);
});

app.post("/api/twilio/voice/record-cb", async (req, res) => {
  const callSid = req.body?.CallSid || "";
  const recordingUrl = req.body?.RecordingUrl || "";
  const duration = req.body?.RecordingDuration || "0";
  await handleRecordingCallback(callSid, recordingUrl, duration);
  res.sendStatus(200);
});

// ── Appointment endpoints ─────────────────────────────
app.get("/api/appointments/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

  const { from, to } = req.query;
  const appts = await getAppointments(tenant.id, from as string, to as string);
  res.json(appts);
});

app.post("/api/appointments/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

  try {
    const appt = await createAppointment({
      id: randomUUID(),
      tenant_id: tenant.id,
      caller_name: req.body.caller_name,
      caller_phone: req.body.caller_phone,
      caller_email: req.body.caller_email,
      staff_name: req.body.staff_name,
      start_time: req.body.start_time,
      end_time: req.body.end_time,
      notes: req.body.notes,
    });
    res.status(201).json(appt);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.put("/api/appointments/:id", async (req, res) => {
  try {
    const appt = await updateAppointment(req.params.id, req.body);
    res.json(appt);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// ── Voice booking endpoints ───────────────────────────
app.post("/api/voice/book/:slug", async (req, res) => {
  const result = await bookAppointment(req.params.slug, req.body);
  res.json(result);
});

app.post("/api/voice/reschedule/:slug", async (req, res) => {
  const result = await rescheduleAppointment(req.params.slug, req.body.appointmentId, req.body.newDateTime);
  res.json(result);
});

app.post("/api/voice/cancel/:slug", async (req, res) => {
  const result = await cancelAppointment(req.params.slug, req.body.appointmentId);
  res.json(result);
});

// ── Call history ──────────────────────────────────────
app.get("/api/calls/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getCalls(tenant.id));
});

// ── Leads ─────────────────────────────────────────────
app.get("/api/admin/leads/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getLeads(tenant.id));
});

// ── Admin: Tenants ────────────────────────────────────
app.get("/api/admin/businesses", async (_req, res) => {
  res.json(await getAllTenants());
});

app.get("/api/admin/businesses/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(tenant);
});

app.post("/api/admin/businesses", async (req, res) => {
  const { name, slug, primary_color, knowledge, calendar_config, routing_rules } = req.body;
  if (!name || !slug) { res.status(400).json({ error: "name and slug required" }); return; }
  const tenant = await upsertTenant({
    id: randomUUID(), name, slug, primary_color,
    knowledge: typeof knowledge === "string" ? knowledge : JSON.stringify(knowledge || {}),
    calendar_config: typeof calendar_config === "string" ? calendar_config : JSON.stringify(calendar_config || {}),
    routing_rules: typeof routing_rules === "string" ? routing_rules : JSON.stringify(routing_rules || {}),
  });
  res.status(201).json(tenant);
});

app.put("/api/admin/businesses/:id", async (req, res) => {
  const { id } = req.params;
  const { name, slug, primary_color, knowledge, calendar_config, routing_rules, phone_number } = req.body;
  if (!name || !slug) { res.status(400).json({ error: "name and slug required" }); return; }
  const tenant = await upsertTenant({
    id, name, slug, primary_color,
    knowledge: typeof knowledge === "string" ? knowledge : JSON.stringify(knowledge || {}),
    calendar_config: typeof calendar_config === "string" ? calendar_config : JSON.stringify(calendar_config || {}),
    routing_rules: typeof routing_rules === "string" ? routing_rules : JSON.stringify(routing_rules || {}),
    phone_number,
  });
  res.json(tenant);
});

app.get("/api/admin/businesses/:slug/leads", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getLeads(tenant.id));
});

// ── Admin: Departments ────────────────────────────────
app.get("/api/admin/departments/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getDepartments(tenant.id));
});

app.post("/api/admin/departments", async (req, res) => {
  const { tenant_id, name, phone, prompt, keypress, order_index } = req.body;
  if (!tenant_id || !name) { res.status(400).json({ error: "tenant_id and name required" }); return; }
  const dept = await upsertDepartment({
    id: randomUUID(), tenant_id, name, phone, prompt, keypress, order_index,
  });
  res.status(201).json(dept);
});

// ── Phase 2: Caller Memory ───────────────────────────
app.get("/api/callers/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const phone = req.query.phone as string;
  if (!phone) { res.status(400).json({ error: "phone query param required" }); return; }
  const ctx = await recognizeCaller(tenant.id, phone);
  res.json(ctx);
});

app.post("/api/callers/:slug/tag", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { phone, tags } = req.body;
  if (!phone || !tags) { res.status(400).json({ error: "phone and tags required" }); return; }
  await tagCaller(tenant.id, phone, Array.isArray(tags) ? tags : [tags]);
  res.json({ success: true });
});

// ── Phase 2: Lead Scoring ─────────────────────────────
app.get("/api/leads/:slug/scores", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const tier = req.query.tier as string | undefined;
  res.json(await getTopLeads(tenant.id, tier as any));
});

app.post("/api/leads/:slug/score", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const result = await scoreLead(tenant.id, req.body);
  res.json(result);
});

// ── Phase 2: Sentiment ────────────────────────────────
app.get("/api/calls/:callId/sentiment", async (req, res) => {
  const summary = await getCallSentimentSummary(req.params.callId);
  res.json(summary);
});

app.post("/api/calls/:callId/sentiment", async (req, res) => {
  const { segments } = req.body;
  if (!segments?.length) { res.status(400).json({ error: "segments array required" }); return; }
  res.json({ success: true });
});

// ── Phase 2: CRM ──────────────────────────────────────
app.post("/api/crm/:slug/find-contact", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { phone, email } = req.body;
  const contact = await findContact(tenant.id, phone || email);
  res.json(contact ? { found: true, contact } : { found: false });
});

app.post("/api/crm/:slug/log-call", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const ok = await logCallToCrm(tenant.id, req.body);
  res.json({ success: ok });
});

// ── Phase 3: SMS ──────────────────────────────────────
app.post("/api/sms/:slug/send", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, body } = req.body;
  if (!to || !body) { res.status(400).json({ error: "to and body required" }); return; }
  const result = await sendSms(tenant.id, to, body);
  res.json(result);
});

// ── Phase 3: Email ────────────────────────────────────
app.post("/api/email/:slug/send", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, subject, body } = req.body;
  if (!to || !subject || !body) { res.status(400).json({ error: "to, subject, body required" }); return; }
  const result = await sendEmail(tenant.id, to, subject, body);
  res.json(result);
});

app.post("/api/email/:slug/invoice", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, amount, description } = req.body;
  if (!to || !amount) { res.status(400).json({ error: "to and amount required" }); return; }
  const result = await sendInvoice(tenant.id, to, amount, description || "Services", tenant.name);
  res.json(result);
});

// ── Phase 3: Payments ─────────────────────────────────
app.post("/api/payments/:slug/create", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const result = await createPayment(tenant.id, req.body);
  res.json(result);
});

app.get("/api/payments/:slug/status/:stripePiId", async (req, res) => {
  const status = await checkPaymentStatus(req.params.stripePiId);
  res.json(status);
});

app.post("/api/payments/:slug/deposit", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { email, name, totalAmount, depositPercent, description } = req.body;
  if (!email || !totalAmount) { res.status(400).json({ error: "email and totalAmount required" }); return; }
  const result = await requestDeposit(tenant.id, email, name, totalAmount, depositPercent, description);
  res.json(result);
});

app.get("/api/payments/:slug/history", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getPaymentIntents(tenant.id));
});

// ── Phase 3: Follow-ups ───────────────────────────────
app.post("/api/followups/:slug/post-call", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const result = await postCallFollowUp(
    { tenantId: tenant.id, businessName: tenant.name, ...req.body.config },
    req.body.outcome,
  );
  res.json(result);
});

// ── Phase 3: Workflows ────────────────────────────────
// Static routes MUST be before parameterized :slug routes
app.get("/api/workflows/templates", async (_req, res) => {
  res.json(WORKFLOW_TEMPLATES);
});

app.get("/api/workflows/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getWorkflows(tenant.id));
});

app.post("/api/workflows/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { name, trigger_event, conditions, actions } = req.body;
  if (!name || !trigger_event || !actions) { res.status(400).json({ error: "name, trigger_event, actions required" }); return; }
  const wf = await createWorkflow({
    id: randomUUID(), tenant_id: tenant.id, name, trigger_event,
    conditions: typeof conditions === "string" ? conditions : JSON.stringify(conditions || {}),
    actions: typeof actions === "string" ? actions : JSON.stringify(actions),
  });
  res.status(201).json(wf);
});

app.post("/api/workflows/:slug/trigger", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { event, data } = req.body;
  if (!event) { res.status(400).json({ error: "event required" }); return; }
  const result = await fireTrigger({ event, tenantId: tenant.id, data: data || {} });
  res.json(result);
});

app.get("/api/workflows/:slug/templates", async (_req, res) => {
  res.json(WORKFLOW_TEMPLATES);
});

// ── Phase 3: Messages ─────────────────────────────────
app.get("/api/messages/:slug", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getMessages(tenant.id));
});

// ── Phase 4: Analytics ────────────────────────────────
app.get("/api/analytics/:slug/dashboard", async (req, res) => {
  const dashboard = await getDashboard(req.params.slug);
  if (!dashboard) { res.status(404).json({ error: "Not found" }); return; }
  res.json(dashboard);
});

app.get("/api/analytics/:slug/quickstats", async (req, res) => {
  const stats = await getQuickStats(req.params.slug);
  res.json({ stats });
});

app.get("/api/analytics/:slug/satisfaction", async (req, res) => {
  const sat = await getCustomerSatisfaction(req.params.slug);
  res.json(sat);
});

// ── Phase 4: Compliance ────────────────────────────────
app.get("/api/compliance/:slug/audit", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(await getAuditTrail(tenant.id));
});

app.post("/api/compliance/:slug/audit", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  await recordAudit(tenant.id, req.body.action, req.body.actor, req.body.details, req.ip);
  res.json({ success: true });
});

app.get("/api/compliance/status", (_req, res) => {
  res.json(getComplianceStatus());
});

app.post("/api/compliance/:slug/consent-twiml", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const twiml = generateConsentTwiml(tenant.name, req.body.nextActionUrl || "/api/twilio/voice");
  res.type("text/xml").send(twiml);
});

// ── Phase 4: Premium — Voice Cloning ───────────────────
app.post("/api/premium/:slug/synthesize", async (req, res) => {
  const { text, voiceId } = req.body;
  if (!text) { res.status(400).json({ error: "text required" }); return; }
  const result = await synthesizeSpeech(text, voiceId);
  res.json(result);
});

// ── Phase 4: Premium — Personas ────────────────────────
app.get("/api/premium/personas", (_req, res) => {
  res.json(PERSONA_TEMPLATES);
});

// ── Phase 4: Premium — Languages ───────────────────────
app.post("/api/premium/:slug/detect-language", (req, res) => {
  const { text } = req.body;
  if (!text) { res.status(400).json({ error: "text required" }); return; }
  res.json({ language: detectLanguage(text) });
});

app.post("/api/premium/:slug/translate", async (req, res) => {
  const { text, targetLang } = req.body;
  if (!text || !targetLang) { res.status(400).json({ error: "text and targetLang required" }); return; }
  const translated = await translateResponse(text, targetLang);
  res.json({ translated });
});

// ── Phase 4: Multi-Channel ─────────────────────────────
app.post("/api/channels/:slug/whatsapp", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, body } = req.body;
  if (!to || !body) { res.status(400).json({ error: "to and body required" }); return; }
  const result = await sendWhatsApp(tenant.id, to, body);
  res.json(result);
});

app.post("/api/channels/:slug/facebook", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, body } = req.body;
  if (!to || !body) { res.status(400).json({ error: "to and body required" }); return; }
  const result = await sendFacebookMessage(tenant.id, to, body);
  res.json(result);
});

app.post("/api/channels/:slug/instagram", async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  const { to, body } = req.body;
  if (!to || !body) { res.status(400).json({ error: "to and body required" }); return; }
  const result = await sendInstagramMessage(tenant.id, to, body);
  res.json(result);
});

// ── Health ────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", phase: "4", timestamp: new Date().toISOString() });
});

// ── Start ─────────────────────────────────────────────
app.listen(PORT, "127.0.0.1", () => {
  console.log(`🧠 AI Receptionist Phase 4 running on http://127.0.0.1:${PORT}`);
  console.log(`   Demo: http://127.0.0.1:${PORT}/widget/demo.js`);
});

export default app;
