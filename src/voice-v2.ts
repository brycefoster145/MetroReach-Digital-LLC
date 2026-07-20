/**
 * Phase 1 Voice Handler — IVR, Call Routing, Appointments, Recording
 */

import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { getTenantBySlug, getDepartments, saveLead } from "./db-v2.js";
import { bookAppointment, rescheduleAppointment, cancelAppointment, getUpcomingAppointments } from "./appointments.js";

let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

// ── TwiML builder ──────────────────────────────────────
const twiml = (...children: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${children.join("")}</Response>`;
const say = (text: string, voice = "Polly.Joanna") => `<Say voice="${voice}">${esc(text)}</Say>`;
const gather = (action: string, sayText: string, timeout = 5) =>
  `<Gather input="speech" action="${esc(action)}" timeout="${timeout}" speechTimeout="auto">${say(sayText)}</Gather>`;
const gatherDtmf = (action: string, sayText: string, numDigits = 1, timeout = 5) =>
  `<Gather input="dtmf" action="${esc(action)}" numDigits="${numDigits}" timeout="${timeout}">${say(sayText)}</Gather>`;
const dial = (number: string, callerId?: string) =>
  `<Dial${callerId ? ` callerId="${esc(callerId)}"` : ""}>${esc(number)}</Dial>`;
const record = (action: string, maxLength = 120) =>
  `<Record action="${esc(action)}" maxLength="${maxLength}" transcribe="true" transcribeCallback="${esc(action)}/transcript"/>`;
const hangup = () => "<Hangup/>";
const pause = (length = 1) => `<Pause length="${length}"/>`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseKnowledge(json: string): any {
  try { return JSON.parse(json); } catch { return {}; }
}

// ── Incoming call handler ──────────────────────────────
export async function handleIncomingCall(slug: string): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return twiml(say("Sorry, I couldn't find this business. Goodbye."), hangup());

  const knowledge = parseKnowledge(tenant.knowledge);
  const name = knowledge.businessName || tenant.name;

  // Check for IVR/department routing
  const depts = await getDepartments(tenant.id);
  if (depts && depts.length > 0) {
    return buildIVRMenu(name, depts, slug);
  }

  // Default: speech-driven greeting
  const hours = knowledge.hours ? ` We're open ${knowledge.hours}.` : "";
  const greeting = `Thank you for calling ${name}. I'm the automated receptionist. How can I help you today?${hours}`;
  const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;

  return twiml(
    say(greeting),
    pause(1),
    gather(respondUrl, "", 5),
  );
}

function buildIVRMenu(businessName: string, depts: any[], slug: string): string {
  const parts: string[] = [];
  parts.push(say(`Thank you for calling ${businessName}.`));

  // Build menu
  const menuParts: string[] = [];
  for (const d of depts) {
    if (d.keypress && d.prompt) {
      menuParts.push(`Press ${d.keypress} for ${d.name}.`);
    }
  }
  menuParts.push("Or just stay on the line and tell me how I can help.");

  parts.push(say(menuParts.join(" ")));
  parts.push(pause(1));

  const routeUrl = `/api/receptionist/twilio/voice/ivr?slug=${encodeURIComponent(slug)}`;
  parts.push(gatherDtmf(routeUrl, "", 1, 5));

  return twiml(...parts);
}

// ── IVR DTMF handler ───────────────────────────────────
export async function handleIVR(slug: string, digits: string): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return twiml(say("Sorry, goodbye."), hangup());

  const depts = await getDepartments(tenant.id);
  const match = depts.find((d: any) => d.keypress === digits);

  if (match && match.phone) {
    return twiml(
      say(`Transferring you to ${match.name}. One moment.`),
      dial(match.phone),
    );
  }

  if (match && match.prompt) {
    // Route to department-specific speech handler
    const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}&dept=${encodeURIComponent(match.id)}`;
    return twiml(say(match.prompt), gather(respondUrl, "", 5));
  }

  // Fallback to main handler
  const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;
  return twiml(say("Let me help you. How can I assist?"), gather(respondUrl, "", 5));
}

// ── Speech response handler ────────────────────────────
export async function handleSpeechResponse(
  slug: string,
  speechResult: string,
  callSid: string,
  dept?: string,
): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return twiml(say("Sorry, goodbye."), hangup());

  const knowledge = parseKnowledge(tenant.knowledge);
  const input = speechResult.trim().toLowerCase();

  // Intent detection
  if (input.match(/appointment|schedule|book|reserve|set up/)) {
    return handleAppointmentIntent(slug, input, knowledge);
  }

  if (input.match(/reschedule|change.*(appointment|time|date)|move.*appointment/)) {
    return handleRescheduleIntent(slug, input, knowledge);
  }

  if (input.match(/cancel|remove.*appointment/)) {
    return handleCancelIntent(slug, input, knowledge);
  }

  if (input.match(/my appointments|upcoming|what.*booked/)) {
    const list = await getUpcomingAppointments(slug);
    const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;
    return twiml(say(list + " Is there anything else?"), gather(respondUrl, "", 5));
  }

  // Transfer request
  if (input.match(/speak to|talk to|human|person|representative|agent|manager|real person/)) {
    if (knowledge.phone) {
      return twiml(say("Let me transfer you. One moment."), dial(knowledge.phone));
    }
    return twiml(say("I don't have a direct number. Please try during business hours."), hangup());
  }

  // Goodbye
  if (input.match(/^(bye|goodbye|thank you|thanks|nothing|no|nope)$/)) {
    return twiml(say(`Thank you for calling ${knowledge.businessName || tenant.name}. Have a great day!`), hangup());
  }

  // GPT response
  try {
    const ai = getOpenAI();
    const systemPrompt = buildVoicePrompt(knowledge);

    const response = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: speechResult },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content?.trim() || getFallback(knowledge, input);

    const shouldCapture = reply.match(/don't have|not sure|take a message|follow up|leave your/i);
    const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;

    if (shouldCapture) {
      const leadUrl = `/api/receptionist/twilio/voice/capture?slug=${encodeURIComponent(slug)}`;
      return twiml(say(reply), say("Would you like to leave your name and number?"), gather(leadUrl, "", 8));
    }

    return twiml(say(reply + " Is there anything else?"), gather(respondUrl, "", 5));
  } catch {
    const reply = getFallback(knowledge, input);
    const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;
    return twiml(say(reply + " Is there anything else?"), gather(respondUrl, "", 5));
  }
}

// ── Appointment intent handlers ─────────────────────────
async function handleAppointmentIntent(slug: string, input: string, knowledge: any): Promise<string> {
  const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;

  // Ask for date/time if not provided
  const timeMatch = input.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today).*?(\d{1,2})\s*(am|pm)/i);
  if (!timeMatch) {
    return twiml(
      say("I'd be happy to book an appointment. What day and time works for you? For example, 'Monday at 3 PM'."),
      gather(respondUrl + "&intent=appointment", "", 5),
    );
  }

  // We have a tentative time — try to book
  const result = await bookAppointment(slug, {
    callerName: "",
    callerPhone: "",
    dateTime: input,
  });

  if (result.success) {
    return twiml(say(result.message), gather(respondUrl, "", 5));
  }

  return twiml(say(result.message), gather(respondUrl, "", 5));
}

async function handleRescheduleIntent(slug: string, input: string, knowledge: any): Promise<string> {
  const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;
  // Simplified — in production, we'd look up the caller's appointments
  return twiml(
    say("I can help reschedule. What's the new date and time you'd like?"),
    gather(respondUrl + "&intent=reschedule", "", 5),
  );
}

async function handleCancelIntent(slug: string, input: string, knowledge: any): Promise<string> {
  const respondUrl = `/api/receptionist/twilio/voice/respond?slug=${encodeURIComponent(slug)}`;
  // Simplified
  return twiml(
    say("I can help cancel your appointment. Do you know the date and time of the appointment you'd like to cancel?"),
    gather(respondUrl + "&intent=cancel", "", 5),
  );
}

// ── Lead capture ──────────────────────────────────────
export async function handleLeadCapture(slug: string, speechResult: string, from: string): Promise<string> {
  const tenant = await getTenantBySlug(slug);
  if (!tenant) return twiml(say("Goodbye."), hangup());

  const input = speechResult.trim();
  const name = input.split(/\d/)[0]?.trim() || input;

  await saveLead({
    id: randomUUID(),
    tenant_id: tenant.id,
    name: name.slice(0, 100),
    email: "",
    phone: from || "",
    question: `Voice call. Caller said: ${input}`,
    source: "voice",
  });

  return twiml(say("I've saved your information. Someone will call back soon. Thank you!"), hangup());
}

// ── Call status callback (for recording) ───────────────
export async function handleRecordingCallback(callSid: string, recordingUrl: string, duration: string): Promise<void> {
  // Store recording info — simplified for now
  console.log(`Recording: ${callSid} → ${recordingUrl} (${duration}s)`);
}

// ── Helpers ────────────────────────────────────────────
function buildVoicePrompt(knowledge: any): string {
  const parts = [
    `You are an AI phone receptionist for ${knowledge.businessName || "a local business"}.`,
    "Keep responses 1-3 sentences. Be warm and professional.",
  ];
  if (knowledge.description) parts.push(`About: ${knowledge.description}`);
  if (knowledge.hours) parts.push(`Hours: ${knowledge.hours}`);
  if (knowledge.phone) parts.push(`Phone: ${knowledge.phone}`);
  if (knowledge.services?.length) parts.push(`Services: ${knowledge.services.join(", ")}`);
  parts.push("If caller wants appointment, ask for day and time. If can't answer, offer callback.");
  return parts.join("\n");
}

function getFallback(knowledge: any, input: string): string {
  if (input.includes("hour")) return knowledge.hours ? `Our hours are ${knowledge.hours}.` : "I don't have the exact hours.";
  if (input.includes("address") || input.includes("where")) return knowledge.address ? `We're at ${knowledge.address}.` : "I don't have the address.";
  if (input.includes("service")) return knowledge.services?.length ? `We offer ${knowledge.services.join(", ")}.` : "How can I help?";
  return "Thanks for calling. How else can I help?";
}
