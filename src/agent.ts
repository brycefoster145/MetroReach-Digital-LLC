import OpenAI from "openai";
import { getTenantBySlug, saveLead } from "./db.js";
import { randomUUID } from "node:crypto";

// Lazy-init OpenAI — fails gracefully if no API key
let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
      throw new Error("OPENAI_API_KEY not configured");
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

interface KnowledgeBase {
  businessName?: string;
  description?: string;
  hours?: string;
  phone?: string;
  email?: string;
  address?: string;
  services?: string[];
  menu?: string[];
  pricing?: string;
  faqs?: { question: string; answer: string }[];
  customNotes?: string;
}

function parseKnowledge(json: string): KnowledgeBase {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function buildSystemPrompt(knowledge: KnowledgeBase): string {
  const parts: string[] = [];

  parts.push(`You are a friendly, helpful AI receptionist for ${knowledge.businessName || "a local business"}.`);
  parts.push("Your job is to answer customer questions accurately and warmly. Be conversational and professional.");

  if (knowledge.description) {
    parts.push(`\nAbout the business: ${knowledge.description}`);
  }
  if (knowledge.hours) {
    parts.push(`\nBusiness hours: ${knowledge.hours}`);
  }
  if (knowledge.phone) {
    parts.push(`\nPhone: ${knowledge.phone}`);
  }
  if (knowledge.email) {
    parts.push(`\nEmail: ${knowledge.email}`);
  }
  if (knowledge.address) {
    parts.push(`\nAddress: ${knowledge.address}`);
  }
  if (knowledge.services && knowledge.services.length > 0) {
    parts.push(`\nServices offered: ${knowledge.services.join(", ")}`);
  }
  if (knowledge.menu && knowledge.menu.length > 0) {
    parts.push(`\nMenu items: ${knowledge.menu.join(", ")}`);
  }
  if (knowledge.pricing) {
    parts.push(`\nPricing information: ${knowledge.pricing}`);
  }
  if (knowledge.faqs && knowledge.faqs.length > 0) {
    const faqText = knowledge.faqs
      .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
      .join("\n");
    parts.push(`\nFrequently Asked Questions:\n${faqText}`);
  }
  if (knowledge.customNotes) {
    parts.push(`\nAdditional notes: ${knowledge.customNotes}`);
  }

  parts.push(`\nIMPORTANT RULES:
1. Always be polite and professional.
2. If you don't know the answer, say so honestly and offer to have someone follow up.
3. If a customer asks something you can't answer, ask if they'd like to leave their name, phone, and email for a follow-up.
4. End each response with a helpful tone.
5. Keep responses concise — 2-4 sentences unless explaining services or FAQs.
6. If asked about pricing, share what you know from the pricing information provided. Don't make up prices.`);

  return parts.join("\n");
}

interface ChatResult {
  reply: string;
  captureLead: boolean;
}

export async function chat(
  businessSlug: string,
  userMessage: string,
  conversationHistory: { role: "user" | "assistant"; content: string }[] = [],
): Promise<ChatResult> {
  const tenant = await getTenantBySlug(businessSlug);
  if (!tenant) {
    return {
      reply: "I'm sorry, I couldn't find this business. Please contact support.",
      captureLead: false,
    };
  }

  const knowledge = parseKnowledge(tenant.knowledge);
  const systemPrompt = buildSystemPrompt(knowledge);

  try {
    const ai = getOpenAI();
    const response = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...conversationHistory.slice(-10), // keep last 10 messages for context
        { role: "user", content: userMessage },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    const reply = response.choices[0]?.message?.content || "I'm not sure about that. Can you rephrase?";

    // Detect if we should capture lead info
    const captureLead =
      userMessage.toLowerCase().includes("leave my") ||
      userMessage.toLowerCase().includes("here's my") ||
      userMessage.toLowerCase().includes("contact me") ||
      userMessage.toLowerCase().includes("follow up") ||
      userMessage.toLowerCase().includes("call me") ||
      userMessage.toLowerCase().includes("email me") ||
      reply.toLowerCase().includes("leave your name") ||
      reply.toLowerCase().includes("contact information");

    return { reply: reply.trim(), captureLead };
  } catch (error: any) {
    console.error("OpenAI error:", error.message);
    // Fallback: use knowledge-based response without AI
    return fallbackChat(knowledge, userMessage);
  }
}

function fallbackChat(knowledge: KnowledgeBase, message: string): ChatResult {
  const msg = message.toLowerCase();

  if (msg.includes("hour") || msg.includes("open") || msg.includes("close")) {
    return {
      reply: knowledge.hours
        ? `Our hours are: ${knowledge.hours}. Is there anything else I can help with?`
        : "I don't have the exact hours handy. Could you call us directly?",
      captureLead: false,
    };
  }

  if (msg.includes("phone") || msg.includes("number") || msg.includes("call")) {
    return {
      reply: knowledge.phone
        ? `You can reach us at ${knowledge.phone}. We'd love to hear from you!`
        : "I don't have a phone number on file. Would you like to leave your contact info for a call back?",
      captureLead: !knowledge.phone,
    };
  }

  if (msg.includes("address") || msg.includes("location") || msg.includes("where")) {
    return {
      reply: knowledge.address
        ? `We're located at ${knowledge.address}. Come visit us!`
        : "I don't have the exact address right now. Could you call us for directions?",
      captureLead: false,
    };
  }

  if (msg.includes("email") || msg.includes("contact")) {
    return {
      reply: knowledge.email
        ? `You can email us at ${knowledge.email}. We typically respond within 24 hours.`
        : "I don't have an email address on file. Would you like to leave your contact info?",
      captureLead: !knowledge.email,
    };
  }

  if (msg.includes("service") || msg.includes("offer") || msg.includes("do you")) {
    return {
      reply: knowledge.services?.length
        ? `We offer: ${knowledge.services.join(", ")}. Which are you interested in?`
        : `At ${knowledge.businessName || "our business"}, we're happy to help! Could you tell me more about what you're looking for?`,
      captureLead: false,
    };
  }

  if (msg.includes("price") || msg.includes("cost") || msg.includes("much")) {
    return {
      reply: knowledge.pricing
        ? `Here's our pricing: ${knowledge.pricing}. Let me know if you have questions!`
        : "I'd be happy to discuss pricing — could you tell me more about what you need?",
      captureLead: true,
    };
  }

  // Default — offer lead capture
  return {
    reply: `Thanks for reaching out to ${knowledge.businessName || "us"}! I'm here to help. Could you tell me more about what you're looking for, or would you like to leave your contact info for a follow-up?`,
    captureLead: true,
  };
}

export async function captureLead(
  businessSlug: string,
  leadInfo: { name: string; email: string; phone: string; question: string },
): Promise<{ success: boolean }> {
  const tenant = await getTenantBySlug(businessSlug);
  if (!tenant) {
    return { success: false };
  }

  saveLead({
    id: randomUUID(),
    tenant_id: tenant.id,
    name: leadInfo.name,
    email: leadInfo.email,
    phone: leadInfo.phone,
    question: leadInfo.question,
    source: "chat",
  });

  return { success: true };
}
