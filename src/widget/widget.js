/**
 * Pindola Systems AI Receptionist Widget
 * 
 * Embed this single <script> tag on any website:
 *   <script src="https://YOUR_HOST/widget/SLUG.js" defer></script>
 * 
 * Customize via data attributes:
 *   <script src="..." data-primary-color="emerald" defer></script>
 */

(function () {
  "use strict";

  const SLUG = "__BUSINESS_SLUG__";
  const BUSINESS_NAME = "__BUSINESS_NAME__";
  const PRIMARY_COLOR = "__PRIMARY_COLOR__";
  const API_BASE = "__API_BASE__" || "";

  // ── Color palette ──────────────────────────────────────
  const COLORS = {
    indigo: { bg: "#4f46e5", bgHover: "#4338ca", bgLight: "#eef2ff", text: "#312e81" },
    blue: { bg: "#2563eb", bgHover: "#1d4ed8", bgLight: "#eff6ff", text: "#1e3a5f" },
    emerald: { bg: "#059669", bgHover: "#047857", bgLight: "#ecfdf5", text: "#064e3b" },
    red: { bg: "#dc2626", bgHover: "#b91c1c", bgLight: "#fef2f2", text: "#7f1d1d" },
    amber: { bg: "#d97706", bgHover: "#b45309", bgLight: "#fffbeb", text: "#78350f" },
    violet: { bg: "#7c3aed", bgHover: "#6d28d9", bgLight: "#f5f3ff", text: "#4c1d95" },
    teal: { bg: "#0d9488", bgHover: "#0f766e", bgLight: "#f0fdfa", text: "#134e4a" },
    rose: { bg: "#e11d48", bgHover: "#be123c", bgLight: "#fff1f2", text: "#881337" },
    gray: { bg: "#4b5563", bgHover: "#374151", bgLight: "#f9fafb", text: "#111827" },
  };

  const C = COLORS[PRIMARY_COLOR] || COLORS.indigo;

  // ── Don't initialize twice ──────────────────────────────
  if (document.getElementById("pindola-widget-root")) return;

  // ── Conversation history ────────────────────────────────
  let history = [];
  let isOpen = false;
  let isLoading = false;
  let showLeadForm = false;

  // ── Build UI ────────────────────────────────────────────
  const root = document.createElement("div");
  root.id = "pindola-widget-root";
  root.innerHTML = `
    <style>
      #pindola-widget-root * { box-sizing: border-box; margin: 0; padding: 0; }
      
      .pw-toggle {
        position: fixed; bottom: 20px; right: 20px; z-index: 99998;
        width: 56px; height: 56px; border-radius: 50%;
        background: ${C.bg}; color: white; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2);
        transition: transform 0.2s, background 0.2s;
        font-size: 24px;
      }
      .pw-toggle:hover { background: ${C.bgHover}; transform: scale(1.05); }
      .pw-toggle.open { transform: rotate(90deg); }
      
      .pw-panel {
        position: fixed; bottom: 88px; right: 20px; z-index: 99997;
        width: 360px; max-width: calc(100vw - 40px); height: 520px;
        max-height: calc(100dvh - 120px);
        background: white; border-radius: 16px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.15);
        display: none; flex-direction: column;
        overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      .pw-panel.open { display: flex; }
      
      .pw-header {
        background: ${C.bg}; color: white; padding: 16px 20px;
        display: flex; align-items: center; gap: 12px;
        flex-shrink: 0;
      }
      .pw-header-avatar {
        width: 36px; height: 36px; border-radius: 50%;
        background: rgba(255,255,255,0.2);
        display: flex; align-items: center; justify-content: center;
        font-size: 18px;
      }
      .pw-header-text { flex: 1; }
      .pw-header-name { font-weight: 600; font-size: 15px; }
      .pw-header-sub { font-size: 12px; opacity: 0.85; }
      .pw-close {
        background: none; border: none; color: white; cursor: pointer;
        font-size: 20px; padding: 4px; opacity: 0.8;
      }
      .pw-close:hover { opacity: 1; }
      
      .pw-messages {
        flex: 1; overflow-y: auto; padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
        background: #f9fafb;
      }
      .pw-msg {
        max-width: 85%; padding: 10px 14px; border-radius: 12px;
        font-size: 14px; line-height: 1.5; word-wrap: break-word;
      }
      .pw-msg.assistant {
        align-self: flex-start; background: white;
        border: 1px solid #e5e7eb; color: #1f2937;
        border-bottom-left-radius: 4px;
      }
      .pw-msg.user {
        align-self: flex-end;
        background: ${C.bg}; color: white;
        border-bottom-right-radius: 4px;
      }
      .pw-msg.thinking {
        align-self: flex-start; background: white;
        border: 1px solid #e5e7eb; color: #9ca3af;
        border-bottom-left-radius: 4px;
        font-style: italic;
      }
      
      .pw-input-area {
        padding: 12px 16px; border-top: 1px solid #e5e7eb;
        display: flex; gap: 8px; flex-shrink: 0;
        background: white;
      }
      .pw-input {
        flex: 1; border: 1px solid #d1d5db; border-radius: 24px;
        padding: 10px 16px; font-size: 14px; outline: none;
        transition: border-color 0.2s;
      }
      .pw-input:focus { border-color: ${C.bg}; }
      .pw-send {
        width: 40px; height: 40px; border-radius: 50%;
        background: ${C.bg}; color: white; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; transition: background 0.2s;
      }
      .pw-send:hover { background: ${C.bgHover}; }
      .pw-send:disabled { opacity: 0.5; cursor: not-allowed; }
      
      .pw-lead-form {
        padding: 12px 16px; border-top: 1px solid #e5e7eb;
        display: none; flex-direction: column; gap: 8px;
        flex-shrink: 0; background: ${C.bgLight};
      }
      .pw-lead-form.show { display: flex; }
      .pw-lead-input {
        border: 1px solid #d1d5db; border-radius: 8px;
        padding: 8px 12px; font-size: 13px; outline: none;
      }
      .pw-lead-input:focus { border-color: ${C.bg}; }
      .pw-lead-submit {
        padding: 8px; border-radius: 8px; border: none;
        background: ${C.bg}; color: white; font-size: 13px;
        font-weight: 600; cursor: pointer;
      }
      .pw-lead-submit:hover { background: ${C.bgHover}; }
      .pw-lead-label {
        font-size: 12px; color: ${C.text}; font-weight: 500;
      }
      
      .pw-branding {
        text-align: center; padding: 6px 16px;
        font-size: 11px; color: #9ca3af; flex-shrink: 0;
        background: white; border-top: 1px solid #f3f4f6;
      }
      .pw-branding span { font-weight: 600; color: #6b7280; }
    </style>

    <button class="pw-toggle" id="pw-toggle" aria-label="Open chat">
      💬
    </button>
    
    <div class="pw-panel" id="pw-panel">
      <div class="pw-header">
        <div class="pw-header-avatar">🤖</div>
        <div class="pw-header-text">
          <div class="pw-header-name">AI Receptionist</div>
          <div class="pw-header-sub">${BUSINESS_NAME}</div>
        </div>
        <button class="pw-close" id="pw-close">✕</button>
      </div>
      
      <div class="pw-messages" id="pw-messages"></div>
      
      <div class="pw-lead-form" id="pw-lead-form">
        <div class="pw-lead-label">Leave your info for a follow-up:</div>
        <input class="pw-lead-input" id="pw-lead-name" placeholder="Your name" />
        <input class="pw-lead-input" id="pw-lead-email" placeholder="Email" type="email" />
        <input class="pw-lead-input" id="pw-lead-phone" placeholder="Phone" type="tel" />
        <button class="pw-lead-submit" id="pw-lead-submit">Send My Info</button>
      </div>
      
      <div class="pw-branding">
        Powered by <span>Pindola Systems</span>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // ── DOM refs ─────────────────────────────────────────────
  const toggle = document.getElementById("pw-toggle");
  const panel = document.getElementById("pw-panel");
  const close = document.getElementById("pw-close");
  const messages = document.getElementById("pw-messages");
  const input = root.querySelector(".pw-input");
  const send = root.querySelector(".pw-send");
  const leadForm = document.getElementById("pw-lead-form");
  const leadName = document.getElementById("pw-lead-name");
  const leadEmail = document.getElementById("pw-lead-email");
  const leadPhone = document.getElementById("pw-lead-phone");
  const leadSubmit = document.getElementById("pw-lead-submit");

  // ── Functions ────────────────────────────────────────────
  function openPanel() {
    isOpen = true;
    panel.classList.add("open");
    toggle.classList.add("open");
    toggle.textContent = "✕";
    if (messages.children.length === 0) {
      addMessage("assistant", `👋 Hi! I'm the AI receptionist for ${BUSINESS_NAME}. How can I help you today?`);
    }
    input.focus();
  }

  function closePanel() {
    isOpen = false;
    panel.classList.remove("open");
    toggle.classList.remove("open");
    toggle.textContent = "💬";
  }

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = "pw-msg " + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function addThinking() {
    const div = document.createElement("div");
    div.className = "pw-msg thinking";
    div.textContent = "Typing...";
    div.id = "pw-thinking";
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeThinking() {
    const el = document.getElementById("pw-thinking");
    if (el) el.remove();
  }

  async function sendMessage(text) {
    if (isLoading) return;
    isLoading = true;
    send.disabled = true;
    input.disabled = true;

    addMessage("user", text);
    history.push({ role: "user", content: text });
    addThinking();

    try {
      const resp = await fetch(API_BASE + "/api/chat/" + SLUG, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: history.slice(-12) }),
      });

      if (!resp.ok) throw new Error("Server error");

      const data = await resp.json();
      removeThinking();
      addMessage("assistant", data.reply);
      history.push({ role: "assistant", content: data.reply });

      if (data.captureLead) {
        leadForm.classList.add("show");
        leadName.focus();
      }
    } catch (err) {
      removeThinking();
      addMessage("assistant", "Sorry, I'm having trouble connecting. Please try again or call us directly.");
      console.error("Pindola Widget error:", err);
    }

    isLoading = false;
    send.disabled = false;
    input.disabled = false;
    input.value = "";
    input.focus();
  }

  async function submitLead() {
    const name = leadName.value.trim();
    const email = leadEmail.value.trim();
    const phone = leadPhone.value.trim();

    if (!name && !email && !phone) {
      leadName.focus();
      return;
    }

    leadSubmit.disabled = true;
    leadSubmit.textContent = "Sending...";

    try {
      await fetch(API_BASE + "/api/leads/" + SLUG, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          phone,
          question: history.filter((h) => h.role === "user").slice(-1)[0]?.content || "No question recorded",
        }),
      });

      leadForm.classList.remove("show");
      leadName.value = "";
      leadEmail.value = "";
      leadPhone.value = "";
      addMessage("assistant", "Thanks! I've saved your information. Someone from " + BUSINESS_NAME + " will follow up with you soon. Is there anything else I can help with?");
    } catch (err) {
      addMessage("assistant", "Sorry, I couldn't save your info. Please call us directly at the number above.");
    }

    leadSubmit.disabled = false;
    leadSubmit.textContent = "Send My Info";
  }

  // ── Event listeners ──────────────────────────────────────
  toggle.addEventListener("click", () => {
    if (isOpen) closePanel();
    else openPanel();
  });

  close.addEventListener("click", closePanel);

  send.addEventListener("click", () => {
    const text = input.value.trim();
    if (text) sendMessage(text);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) sendMessage(text);
    }
  });

  leadSubmit.addEventListener("click", submitLead);

  console.log("🤖 Pindola AI Receptionist ready for", BUSINESS_NAME);
})();
