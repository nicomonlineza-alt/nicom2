// Supabase Edge Function: send-message
// Allows human operators in the Nicom-AI inbox to send messages to Facebook Messenger customers.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAGE_ACCESS_TOKEN = Deno.env.get("MESSENGER_PAGE_ACCESS_TOKEN")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { conversation_id, message_text, operator_name } = await req.json();

    if (!conversation_id || !message_text) {
      return new Response(JSON.stringify({ error: "conversation_id and message_text are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 1. Fetch conversation
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("external_user_id")
      .eq("id", conversation_id)
      .single();

    if (convErr || !conv) {
      return new Response(JSON.stringify({ error: "Conversation not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 2. Dispatch to Meta Messenger
    const metaRes = await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: conv.external_user_id },
        message: { text: message_text }
      })
    });

    if (!metaRes.ok) {
      const errText = await metaRes.text();
      console.error("Meta Send API Error:", errText);
      return new Response(JSON.stringify({ error: `Meta API error: ${errText}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const metaData = await metaRes.json();

    // 3. Save operator message and enable human_takeover
    const { data: savedMsg, error: msgErr } = await supabase
      .from("messages")
      .insert({
        conversation_id,
        sender_type: "operator",
        sender_id: operator_name || "Operator",
        message_text,
        facebook_mid: metaData.message_id
      })
      .select()
      .single();

    if (msgErr) console.error("Error saving operator message:", msgErr);

    await supabase
      .from("conversations")
      .update({ human_takeover: true, last_message_at: new Date().toISOString() })
      .eq("id", conversation_id);

    return new Response(JSON.stringify({ success: true, message: savedMsg }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("send-message exception:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
