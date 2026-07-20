/**
 * Phase 4 — Premium Features
 *
 * Voice cloning (ElevenLabs), custom personas,
 * multi-language support.
 */

import OpenAI from "openai";
import { getTenantBySlug } from "./db.js";

// ── ElevenLabs voice cloning ──────────────────────────────

interface ElevenLabsConfig {
  apiKey?: string;
  voiceId?: string;
  stability?: number;
  similarityBoost?: number;
}

function getElevenLabsConfig(): ElevenLabsConfig {
  return {
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID,
    stability: parseFloat(process.env.ELEVENLABS_STABILITY || "0.5"),
    similarityBoost: parseFloat(process.env.ELEVENLABS_SIMILARITY || "0.75"),
  };
}

export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
): Promise<{ success: boolean; audioBase64?: string; error?: string }> {
  const config = getElevenLabsConfig();
  if (!config.apiKey) {
    return { success: false, error: "ELEVENLABS_API_KEY not configured" };
  }

  const vid = voiceId || config.voiceId || "21m00Tcm4TlvDq8ikWAM"; // default "Rachel"

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: "POST",
      headers: {
        "xi-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_settings: {
          stability: config.stability,
          similarity_boost: config.similarityBoost,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      return { success: false, error: (err as any).detail?.message || "ElevenLabs error" };
    }

    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    return { success: true, audioBase64: base64 };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ── Custom Personas ────────────────────────────────────────

export interface Persona {
  name: string;
  tone: "professional" | "friendly" | "luxury" | "casual" | "urgent";
  greeting: string;
  phrases: string[];
  voice?: { provider: "polly" | "elevenlabs"; voiceId: string };
  rules: string[];
}

export const PERSONA_TEMPLATES: Record<string, Persona> = {
  professional: {
    name: "Professional",
    tone: "professional",
    greeting: "Thank you for calling. How may I direct your call?",
    phrases: [
      "I understand. Let me assist you with that.",
      "One moment while I look into this.",
      "I appreciate your patience.",
    ],
    voice: { provider: "polly", voiceId: "Joanna" },
    rules: ["Be concise and efficient", "Use formal language", "Prioritize quick resolution"],
  },
  friendly: {
    name: "Friendly",
    tone: "friendly",
    greeting: "Hey there! Thanks for calling — how can I help you today?",
    phrases: [
      "Great question! Let me check on that for you.",
      "No worries at all — I'm here to help!",
      "Awesome, let's get that sorted!",
    ],
    voice: { provider: "polly", voiceId: "Salli" },
    rules: ["Be warm and conversational", "Use casual language", "Build rapport"],
  },
  luxury: {
    name: "Luxury",
    tone: "luxury",
    greeting: "Good day. Thank you for calling. It's a pleasure to assist you.",
    phrases: [
      "Certainly. I'll ensure that's handled with the utmost care.",
      "I appreciate your discerning taste. Let me attend to this personally.",
      "Of course. Your satisfaction is our highest priority.",
    ],
    voice: { provider: "polly", voiceId: "Joanna" },
    rules: ["Use elevated, refined language", "Address caller with respect", "Emphasize exclusivity and care"],
  },
};

export function getPersonaPrompt(persona: Persona): string {
  return [
    `You are a ${persona.tone} AI receptionist named "${persona.name}".`,
    `Default greeting: "${persona.greeting}"`,
    persona.phrases.length > 0 ? `Useful phrases: ${persona.phrases.join(" | ")}` : "",
    `Rules: ${persona.rules.join("; ")}`,
  ].filter(Boolean).join("\n");
}

// ── Multi-language support ─────────────────────────────────

const LANG_PATTERNS: Record<string, RegExp[]> = {
  es: [/hola|gracias|por favor|buenos días|buenas tardes/i],
  fr: [/bonjour|merci|s'il vous plaît|au revoir|bonsoir/i],
  de: [/hallo|danke|bitte|guten tag|auf wiedersehen/i],
  zh: [/你好|谢谢|请|再见|您好/i],
  ja: [/こんにちは|ありがとう|お願い|さようなら/i],
};

export function detectLanguage(text: string): string {
  for (const [lang, patterns] of Object.entries(LANG_PATTERNS)) {
    if (patterns.some(p => p.test(text))) return lang;
  }
  return "en";
}

export const LANG_NAMES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  zh: "Chinese",
  ja: "Japanese",
};

export function getLanguagePrompt(lang: string, businessName: string): string {
  const langName = LANG_NAMES[lang] || "English";

  if (lang === "en") return "";

  return `IMPORTANT: The caller is speaking ${langName}. You MUST respond in ${langName}. Greet them in ${langName}. All responses must be in ${langName}. The business name is ${businessName}.`;
}

// ── Translate via GPT ─────────────────────────────────────
export async function translateResponse(
  text: string,
  targetLang: string,
): Promise<string> {
  if (targetLang === "en") return text;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return text; // Can't translate without AI

  try {
    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate the following to ${LANG_NAMES[targetLang] || targetLang}. Return ONLY the translation, no explanations.` },
        { role: "user", content: text },
      ],
      max_tokens: 200,
    });
    return response.choices[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}
