# Nicom-AI — Facebook Messenger & CRM Backend

This directory contains the Supabase database migrations and Edge Functions for Nicom-AI's Facebook Messenger integration and AI employee routing (John, Cathy, Saun, Jenny).

## 1. Apply Database Migration
In your Supabase project dashboard:
1. Go to **SQL Editor** -> **New query**.
2. Paste the contents of `migrations/20261113000000_messenger_and_crm.sql`.
3. Click **Run**.
This creates:
- `conversations`: customer threads, assigned employee, and `human_takeover` flag.
- `messages`: inbound/outbound chat history with Realtime enabled.
- `leads`: customer enquiries and sales qualification.

## 2. Set Supabase Edge Function Secrets
In your terminal (using Supabase CLI) or via Supabase Dashboard -> **Project Settings** -> **Edge Functions**:
```bash
supabase secrets set MESSENGER_VERIFY_TOKEN="your-chosen-random-token"
supabase secrets set MESSENGER_APP_SECRET="your-meta-app-secret"
supabase secrets set MESSENGER_PAGE_ACCESS_TOKEN="your-page-access-token"
supabase secrets set OPENAI_API_KEY="your-openai-key" # Optional for Cathy/Saun/Jenny/John responses
```

## 3. Deploy Edge Functions
Deploy using the Supabase CLI:
```bash
supabase functions deploy messenger-webhook --no-verify-jwt
supabase functions deploy send-message
```
*(Note: `--no-verify-jwt` is required on `messenger-webhook` so Meta's servers can deliver webhooks directly without Supabase JWT authentication).*

## 4. Meta Developer Portal Webhook Setup
1. In [developers.facebook.com](https://developers.facebook.com), open your App -> **Messenger** -> **Webhook**.
2. Click **Add Callback URL**:
   - **Callback URL**: `https://<your-project-ref>.supabase.co/functions/v1/messenger-webhook`
   - **Verify Token**: The value you set for `MESSENGER_VERIFY_TOKEN`.
3. Click **Verify and Save**.
4. Under **Subscription Fields**, select `messages` and `messaging_postbacks`.
5. Under your Facebook Page section, click **Subscribe** to link your Page to the webhook.
