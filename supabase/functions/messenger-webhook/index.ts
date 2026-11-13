// Supabase Edge Function: messenger-webhook
// Handles Facebook Messenger webhook verification, message receipt, AI routing, and responses.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("MESSENGER_VERIFY_TOKEN")!;
const APP_SECRET = Deno.env.get("MESSENGER_APP_SECRET")!;
const PAGE_ACCESS_TOKEN = Deno.env.get("MESSENGER_PAGE_ACCESS_TOKEN")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Employee persona prompts matching Nicom-AI site
const PERSONAS: Record<string, string> = {
  john: `You are John, Team Lead for Nicom-AI. You oversee operations, business communications, and digital strategy. You are professional, strategic, coordinating, and reassuring. If a question is sales-focused, pass it to Cathy; if technical, pass to Saun; if accounting/billing, pass to Jenny.`,
  cathy: `You are Cathy, Head of Marketing & Sales at Nicom-AI. Your mission is client acquisition, answering questions about intelligent web apps, digital marketing, AI agents, website design, and growth solutions. You are warm, consultative, and guide prospects toward getting a tailored quote or booking a consultation. Try to politely capture their name, email, or contact number.`,
  saun: `You are Saun, Technical Expert at Nicom-AI providing 24/7 product & service support. You have deep knowledge of hosting, web systems, automation, and digital infrastructure. You provide clear, step-by-step technical guidance and diagnose customer issues.`,
  jenny: `You are Jenny, Head of Accounting at Nicom-AI. You handle invoicing, payments, account allocations, quotes, and billing queries. You are precise, courteous, and efficient.`
};

// HMAC-SHA256 signature verification for Meta security
async function verifySignature(req: Request, rawBody: string): Promise<boolean> {
  const signature = req.headers.get("x-hub-signature-256");
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expectedHash = signature.replace("sha256=", "");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const hashArray = Array.from(new Uint8Array(sigBuffer));
  const computedHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return computedHash === expectedHash;
}

// Send message back to Facebook Messenger via Meta Graph API
async function sendMessengerMessage(recipientId: string, text: string) {
  const res = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text }
    })
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error("Meta Send API Error:", errorBody);
    throw new Error(`Failed to send Messenger message: ${errorBody}`);
  }
}

// Classify customer intent to route to John, Cathy, Saun, or Jenny
function classifyEmployee(text: string): "cathy" | "saun" | "jenny" | "john" {
  const lower = text.toLowerCase();
  if (/invoice|payment|billing|price|cost|pay|refund|bank|accountant/i.test(lower)) {
    return "jenny";
  }
  if (/bug|error|broken|server|host|domain|technical|code|api|not working|crash|down/i.test(lower)) {
    return "saun";
  }
  if (/service|hire|build|quote|website|app|marketing|leads|sales|consult|project|interested/i.test(lower)) {
    return "cathy";
  }
  return "john";
}

// Generate AI response
async function generateAiReply(agent: string, customerMessage: string, history: Array<{ sender: string; text: string }>): Promise<string> {
  if (!OPENAI_API_KEY) {
    return `Hi there! Thank you for contacting Nicom-AI. I'm ${agent.charAt(0).toUpperCase() + agent.slice(1)}, and our team has received your message. One of our specialists will be with you shortly.`;
  }

  const systemPrompt = PERSONAS[agent] || PERSONAS.john;
  const messages = [
    { role: "system", content: `${systemPrompt}\nKeep your replies concise, friendly, and suitable for Facebook Messenger (under 3 short paragraphs). Never make up pricing not verified.` },
    ...history.slice(-5).map(h => ({
      role: h.sender === "customer" ? "user" : "assistant",
      content: h.text
    })),
    { role: "user", content: customerMessage }
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 300,
      temperature: 0.7
    })
  });

  if (!res.ok) {
    console.error("OpenAI API error:", await res.text());
    return `Thank you for your message. I am ${agent.charAt(0).toUpperCase() + agent.slice(1)} from Nicom-AI. How can I best assist you today?`;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "Thank you for reaching out to Nicom-AI!";
}

serve(async (req) => {
  const url = new URL(req.url);

  // 1. Webhook Verification (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Meta Webhook Verified successfully.");
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden: Invalid verification token", { status: 403 });
  }

  // 2. Incoming Events (POST)
  if (req.method === "POST") {
    const rawBody = await req.text();

    // Verify signature if APP_SECRET is provided
    if (APP_SECRET) {
      const isValid = await verifySignature(req, rawBody);
      if (!isValid) {
        console.warn("Invalid webhook signature rejected.");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const payload = JSON.parse(rawBody);

    if (payload.object === "page") {
      for (const entry of payload.entry || []) {
        for (const event of entry.messaging || []) {
          // Skip echo messages (messages sent by our own page)
          if (event.message?.is_echo) continue;

          const senderId = event.sender?.id; // Customer PSID
          const text = event.message?.text;
          const mid = event.message?.mid;

          if (!senderId || !text) continue;

          // 1. Get or create conversation record
          let { data: conv } = await supabase
            .from("conversations")
            .select("*")
            .eq("platform", "messenger")
            .eq("external_user_id", senderId)
            .single();

          if (!conv) {
            const initialAgent = classifyEmployee(text);
            const { data: newConv, error: convErr } = await supabase
              .from("conversations")
              .insert({
                platform: "messenger",
                external_user_id: senderId,
                assigned_agent: initialAgent,
                status: "open",
                human_takeover: false,
                last_message_at: new Date().toISOString()
              })
              .select()
              .single();

            if (convErr) console.error("Error creating conversation:", convErr);
            conv = newConv;
          } else {
            // Update last_message_at
            await supabase
              .from("conversations")
              .update({ last_message_at: new Date().toISOString(), status: "open" })
              .eq("id", conv.id);
          }

          if (!conv) continue;

          // 2. Insert customer message
          await supabase.from("messages").insert({
            conversation_id: conv.id,
            sender_type: "customer",
            sender_id: senderId,
            message_text: text,
            facebook_mid: mid
          });

          // 3. AI response handling if human takeover is false
          if (!conv.human_takeover) {
            // Load recent history for context
            const { data: recentMsgs } = await supabase
              .from("messages")
              .select("sender_type, message_text")
              .eq("conversation_id", conv.id)
              .order("created_at", { ascending: false })
              .limit(6);

            const history = (recentMsgs || []).reverse().map(m => ({
              sender: m.sender_type,
              text: m.message_text
            }));

            const agent = conv.assigned_agent || "cathy";
            const aiReply = await generateAiReply(agent, text, history);

            // Record AI response
            await supabase.from("messages").insert({
              conversation_id: conv.id,
              sender_type: "ai",
              agent_name: agent.charAt(0).toUpperCase() + agent.slice(1),
              message_text: aiReply
            });

            // Send to Messenger
            await sendMessengerMessage(senderId, aiReply);

            // Lead extraction if email/phone detected
            const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
            const phoneMatch = text.match(/(?:\+?27|0)\s?\d{2}\s?\d{3}\s?\d{4}/);
            if (emailMatch || phoneMatch) {
              await supabase.from("leads").upsert({
                conversation_id: conv.id,
                email: emailMatch ? emailMatch[0] : null,
                phone: phoneMatch ? phoneMatch[0] : null,
                assigned_employee: agent,
                status: "new",
                notes: `Captured via Messenger by ${agent}`
              }, { onConflict: "conversation_id" });
            }
          }
        }
      }
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  }

  return new Response("Method Not Allowed", { status: 405 });
});
