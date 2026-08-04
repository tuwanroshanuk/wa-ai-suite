CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'agent', -- 'admin' | 'agent'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL, -- WhatsApp phone number id (E.164 no plus)
  name TEXT,
  attributes JSONB DEFAULT '{}',
  bot_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed | pending
  assigned_agent_id INTEGER REFERENCES users(id),
  active_flow_id INTEGER,
  flow_state JSONB DEFAULT '{}',
  last_message_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL, -- inbound | outbound
  sender TEXT NOT NULL,    -- 'bot' | 'agent:<id>' | 'customer'
  wa_message_id TEXT,
  type TEXT NOT NULL DEFAULT 'text', -- text | image | audio | template | interactive
  body TEXT,
  media_url TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flows (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT false,
  is_default_greeting BOOLEAN DEFAULT false,
  -- Flow graph: { nodes: [...], edges: [...] } built by the React Flow UI
  graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  wa_call_id TEXT UNIQUE,
  direction TEXT NOT NULL, -- inbound | outbound
  handled_by TEXT NOT NULL DEFAULT 'bot', -- unassigned | bot | agent:<id>
  status TEXT NOT NULL DEFAULT 'ringing', -- ringing | connected | ended | rejected | missed | failed
  consent_status TEXT DEFAULT 'not_required', -- not_required | requested | granted | denied
  recording_path TEXT,
  transcript JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL, -- pre-recorded free audio clips (greetings, menus)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id);
