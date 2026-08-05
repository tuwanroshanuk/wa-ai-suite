CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'agent',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id SERIAL PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  attributes JSONB DEFAULT '{}',
  bot_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_agent_id INTEGER REFERENCES users(id),
  active_flow_id INTEGER,
  flow_state JSONB DEFAULT '{}',
  last_message_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  sender TEXT NOT NULL,
  wa_message_id TEXT,
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  media_url TEXT,
  raw JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flows (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN DEFAULT false,
  is_default_greeting BOOLEAN DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1,
  graph JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
  validation JSONB NOT NULL DEFAULT '{"valid":false,"errors":[],"warnings":[]}',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE flows ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE flows ADD COLUMN IF NOT EXISTS validation JSONB NOT NULL DEFAULT '{"valid":false,"errors":[],"warnings":[]}';
ALTER TABLE flows ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS calls (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  wa_call_id TEXT UNIQUE,
  direction TEXT NOT NULL,
  handled_by TEXT NOT NULL DEFAULT 'ivr',
  status TEXT NOT NULL DEFAULT 'ringing',
  consent_status TEXT DEFAULT 'not_required',
  recording_path TEXT,
  transcript JSONB DEFAULT '[]',
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ivr_events (
  id BIGSERIAL PRIMARY KEY,
  call_id INTEGER REFERENCES calls(id) ON DELETE CASCADE,
  flow_id INTEGER REFERENCES flows(id) ON DELETE SET NULL,
  node_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audio_assets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_ivr_events_call ON ivr_events(call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivr_events_flow ON ivr_events(flow_id, created_at DESC);

INSERT INTO flows (name,description,graph,validation)
SELECT
  'Default customer service IVR',
  'A safe starting phone menu. Edit, validate and publish it from the IVR Builder.',
  '{
    "nodes":[
      {"id":"start","type":"start","position":{"x":80,"y":180},"data":{"label":"Incoming call"}},
      {"id":"welcome","type":"speak","position":{"x":330,"y":180},"data":{"label":"Welcome","text":"Welcome. Please say support to speak with an agent, say hours for our opening hours, or say goodbye to end the call."}},
      {"id":"menu","type":"menu","position":{"x":620,"y":180},"data":{"label":"Main menu","text":"How may I direct your call?","variable":"department","maxAttempts":3,"invalidText":"Sorry, please say support, hours, or goodbye.","choices":[{"label":"Support","value":"support","keywords":["agent","human","help"]},{"label":"Opening hours","value":"hours","keywords":["open","opening"]},{"label":"End call","value":"goodbye","keywords":["bye","end"]}]}},
      {"id":"transfer","type":"transfer","position":{"x":930,"y":40},"data":{"label":"Transfer to agent","message":"Please hold while I connect you to an available agent.","team":"all"}},
      {"id":"hours","type":"speak","position":{"x":930,"y":180},"data":{"label":"Opening hours","text":"Our team is available Monday to Friday, from nine in the morning until five in the afternoon."}},
      {"id":"thanks","type":"speak","position":{"x":1210,"y":180},"data":{"label":"Anything else","text":"Thank you for calling."}},
      {"id":"end","type":"end","position":{"x":1460,"y":180},"data":{"label":"End call","message":"Goodbye.","reason":"completed"}},
      {"id":"fallback","type":"speak","position":{"x":930,"y":330},"data":{"label":"Fallback","text":"I could not match that selection. I will end the call now."}}
    ],
    "edges":[
      {"id":"e1","source":"start","target":"welcome"},
      {"id":"e2","source":"welcome","target":"menu"},
      {"id":"e3","source":"menu","sourceHandle":"support","target":"transfer"},
      {"id":"e4","source":"menu","sourceHandle":"hours","target":"hours"},
      {"id":"e5","source":"menu","sourceHandle":"goodbye","target":"end"},
      {"id":"e6","source":"menu","sourceHandle":"default","target":"fallback"},
      {"id":"e7","source":"hours","target":"thanks"},
      {"id":"e8","source":"thanks","target":"end"},
      {"id":"e9","source":"fallback","target":"end"}
    ]
  }'::jsonb,
  '{"valid":true,"errors":[],"warnings":[]}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM flows);
