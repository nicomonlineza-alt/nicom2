-- Migration: Facebook Messenger Integration and Nicom-AI CRM Tables
-- Timestamp: 2026-11-13

-- 1. Helper function for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Conversations Table (Messenger threads)
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT NOT NULL DEFAULT 'messenger',
    external_user_id TEXT NOT NULL, -- Facebook Page-Scoped ID (PSID)
    customer_name TEXT,
    customer_profile_pic TEXT,
    assigned_agent TEXT NOT NULL DEFAULT 'john' CHECK (assigned_agent IN ('john', 'cathy', 'saun', 'jenny')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'archived')),
    human_takeover BOOLEAN NOT NULL DEFAULT false,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_platform_user UNIQUE (platform, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON public.conversations (platform, external_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON public.conversations (assigned_agent);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON public.conversations (status);

CREATE TRIGGER trg_conversations_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 3. Messages Table (Chat history)
CREATE TABLE IF NOT EXISTS public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'ai', 'operator')),
    sender_id TEXT, -- PSID or operator user ID
    agent_name TEXT CHECK (agent_name IN ('John', 'Cathy', 'Saun', 'Jenny', NULL)),
    message_text TEXT NOT NULL,
    attachments JSONB DEFAULT '[]'::jsonb,
    facebook_mid TEXT, -- Meta message ID
    status TEXT DEFAULT 'delivered' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON public.messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_fb_mid ON public.messages (facebook_mid);

-- 4. Leads Table (CRM capture)
CREATE TABLE IF NOT EXISTS public.leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    name TEXT,
    email TEXT,
    phone TEXT,
    intent TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'closed')),
    assigned_employee TEXT NOT NULL DEFAULT 'cathy' CHECK (assigned_employee IN ('cathy', 'saun', 'jenny', 'john')),
    notes TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads (status);
CREATE INDEX IF NOT EXISTS idx_leads_employee ON public.leads (assigned_employee);

CREATE TRIGGER trg_leads_updated_at
BEFORE UPDATE ON public.leads
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- 5. Row Level Security (RLS)
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- Service role has full bypass; authenticated staff can read and manage
CREATE POLICY "Allow service role full access on conversations"
ON public.conversations FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated staff to read conversations"
ON public.conversations FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow authenticated staff to update conversations"
ON public.conversations FOR UPDATE
TO authenticated
USING (true);

CREATE POLICY "Allow service role full access on messages"
ON public.messages FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated staff to read messages"
ON public.messages FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Allow authenticated staff to insert messages"
ON public.messages FOR INSERT
TO authenticated
WITH CHECK (true);

CREATE POLICY "Allow service role full access on leads"
ON public.leads FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated staff to manage leads"
ON public.leads FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- 6. Enable Realtime on conversations and messages for live inbox updates
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'conversations'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' AND tablename = 'messages'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
    END IF;
END $$;
