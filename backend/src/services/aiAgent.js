import { query } from "../db/index.js";

const SETTINGS_KEY = "ai_agent";

const DEFAULT_SETTINGS = {
  enabled: true,
  engine: "standard",
  textModel: "gemini-3.5-flash-lite",
  liveModel: "gemini-3.1-flash-live-preview",
  liveVoice: "Kore",
  thinkingLevel: "minimal",
  agentName: "Nexus Support Assistant",
  companyName: "Nexus",
  role: "Customer support voice assistant",
  objective:
    "Understand the caller's request, answer accurately from company knowledge, and guide them to the next useful step.",
  tone: "Friendly, calm, professional, concise, and natural for a phone conversation.",
  instructions:
    "Ask one question at a time. Keep spoken replies short. Confirm important numbers, dates, names, and commitments before acting.",
  guardrails:
    "Never invent company policies, prices, availability, legal claims, or account details. If the knowledge base does not contain the answer, say that you are not certain and offer human follow-up.",
  languageMode: "match_caller",
  fallbackMessage:
    "I’m sorry, I’m having trouble accessing the assistant service right now. Please hold for an agent or try again shortly.",
  greeting:
    "Hello. Thanks for calling. You’re speaking with our AI assistant. How can I help you today?",
  knowledgeEnabled: true,
  maxKnowledgeChars: 14000,
};

const LIVE_VOICES = [
  { id: "Zephyr", label: "Zephyr — Bright" },
  { id: "Puck", label: "Puck — Upbeat" },
  { id: "Charon", label: "Charon — Informative" },
  { id: "Kore", label: "Kore — Firm" },
  { id: "Fenrir", label: "Fenrir — Excitable" },
  { id: "Leda", label: "Leda — Youthful" },
  { id: "Orus", label: "Orus — Firm" },
  { id: "Aoede", label: "Aoede — Breezy" },
  { id: "Callirrhoe", label: "Callirrhoe — Easy-going" },
  { id: "Autonoe", label: "Autonoe — Bright" },
  { id: "Enceladus", label: "Enceladus — Breathy" },
  { id: "Iapetus", label: "Iapetus — Clear" },
  { id: "Umbriel", label: "Umbriel — Easy-going" },
  { id: "Algieba", label: "Algieba — Smooth" },
  { id: "Despina", label: "Despina — Smooth" },
  { id: "Erinome", label: "Erinome — Clear" },
  { id: "Algenib", label: "Algenib — Gravelly" },
  { id: "Rasalgethi", label: "Rasalgethi — Informative" },
  { id: "Laomedeia", label: "Laomedeia — Upbeat" },
  { id: "Achernar", label: "Achernar — Soft" },
  { id: "Alnilam", label: "Alnilam — Firm" },
  { id: "Schedar", label: "Schedar — Even" },
  { id: "Gacrux", label: "Gacrux — Mature" },
  { id: "Pulcherrima", label: "Pulcherrima — Forward" },
  { id: "Achird", label: "Achird — Friendly" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi — Casual" },
  { id: "Vindemiatrix", label: "Vindemiatrix — Gentle" },
  { id: "Sadachbia", label: "Sadachbia — Lively" },
  { id: "Sadaltager", label: "Sadaltager — Knowledgeable" },
  { id: "Sulafat", label: "Sulafat — Warm" },
];

function cleanText(value, fallback = "", limit = 12000) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, limit);
}

function normalizeSettings(value = {}) {
  const engine = ["standard", "gemini_live"].includes(value.engine)
    ? value.engine
    : DEFAULT_SETTINGS.engine;
  const thinkingLevel = ["minimal", "low", "medium", "high"].includes(value.thinkingLevel)
    ? value.thinkingLevel
    : DEFAULT_SETTINGS.thinkingLevel;
  const liveVoice = LIVE_VOICES.some((voice) => voice.id === value.liveVoice)
    ? value.liveVoice
    : DEFAULT_SETTINGS.liveVoice;
  const maxKnowledgeChars = Number(value.maxKnowledgeChars ?? DEFAULT_SETTINGS.maxKnowledgeChars);

  return {
    enabled: value.enabled !== false,
    engine,
    textModel: cleanText(value.textModel, DEFAULT_SETTINGS.textModel, 120),
    liveModel: cleanText(value.liveModel, DEFAULT_SETTINGS.liveModel, 120),
    liveVoice,
    thinkingLevel,
    agentName: cleanText(value.agentName, DEFAULT_SETTINGS.agentName, 160),
    companyName: cleanText(value.companyName, DEFAULT_SETTINGS.companyName, 160),
    role: cleanText(value.role, DEFAULT_SETTINGS.role, 1000),
    objective: cleanText(value.objective, DEFAULT_SETTINGS.objective, 4000),
    tone: cleanText(value.tone, DEFAULT_SETTINGS.tone, 2000),
    instructions: cleanText(value.instructions, DEFAULT_SETTINGS.instructions, 8000),
    guardrails: cleanText(value.guardrails, DEFAULT_SETTINGS.guardrails, 8000),
    languageMode: value.languageMode === "english_only" ? "english_only" : "match_caller",
    fallbackMessage: cleanText(
      value.fallbackMessage,
      DEFAULT_SETTINGS.fallbackMessage,
      1500
    ),
    greeting: cleanText(value.greeting, DEFAULT_SETTINGS.greeting, 1500),
    knowledgeEnabled: value.knowledgeEnabled !== false,
    maxKnowledgeChars: Math.max(
      1000,
      Math.min(40000, Number.isFinite(maxKnowledgeChars) ? maxKnowledgeChars : 14000)
    ),
  };
}

export function getLiveVoiceCatalog() {
  return LIVE_VOICES;
}

export async function getAiAgentSettings() {
  const result = await query("SELECT value FROM app_settings WHERE key=$1", [SETTINGS_KEY]);
  return normalizeSettings(result.rows[0]?.value || DEFAULT_SETTINGS);
}

export async function saveAiAgentSettings(value) {
  const settings = normalizeSettings(value);
  await query(
    `INSERT INTO app_settings (key,value,updated_at)
     VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [SETTINGS_KEY, settings]
  );
  return settings;
}

function cleanTags(value) {
  const list = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());
  return [...new Set(list.map((item) => item.slice(0, 60)).filter(Boolean))].slice(0, 20);
}

export async function listKnowledgeEntries({ activeOnly = false } = {}) {
  const result = await query(
    `SELECT id,title,content,tags,is_active,created_at,updated_at
       FROM knowledge_entries
      ${activeOnly ? "WHERE is_active=true" : ""}
      ORDER BY updated_at DESC,id DESC`
  );
  return result.rows;
}

export async function createKnowledgeEntry(value) {
  const title = cleanText(value.title, "", 240);
  const content = cleanText(value.content, "", 30000);
  if (!title) throw new Error("Knowledge title is required.");
  if (!content) throw new Error("Knowledge content is required.");
  const result = await query(
    `INSERT INTO knowledge_entries (title,content,tags,is_active)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [title, content, cleanTags(value.tags), value.isActive !== false]
  );
  return result.rows[0];
}

export async function updateKnowledgeEntry(id, value) {
  const title = cleanText(value.title, "", 240);
  const content = cleanText(value.content, "", 30000);
  if (!title) throw new Error("Knowledge title is required.");
  if (!content) throw new Error("Knowledge content is required.");
  const result = await query(
    `UPDATE knowledge_entries
        SET title=$1,content=$2,tags=$3,is_active=$4,updated_at=now()
      WHERE id=$5 RETURNING *`,
    [title, content, cleanTags(value.tags), value.isActive !== false, id]
  );
  if (!result.rows[0]) throw new Error("Knowledge entry not found.");
  return result.rows[0];
}

export async function deleteKnowledgeEntry(id) {
  const result = await query("DELETE FROM knowledge_entries WHERE id=$1 RETURNING id", [id]);
  return Boolean(result.rows[0]);
}

async function findRelevantKnowledge(searchText, limit = 8) {
  const clean = cleanText(searchText, "", 1000);
  if (!clean) {
    const result = await query(
      `SELECT id,title,content,tags
         FROM knowledge_entries
        WHERE is_active=true
        ORDER BY updated_at DESC
        LIMIT $1`,
      [limit]
    );
    return result.rows;
  }

  const result = await query(
    `WITH search AS (SELECT plainto_tsquery('simple',$1) AS q)
     SELECT id,title,content,tags,
            ts_rank(
              to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || array_to_string(tags,' ')),
              search.q
            ) AS rank
       FROM knowledge_entries,search
      WHERE is_active=true
        AND (
          search.q = ''::tsquery OR
          to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || array_to_string(tags,' ')) @@ search.q OR
          title ILIKE '%' || $1 || '%' OR
          content ILIKE '%' || $1 || '%'
        )
      ORDER BY rank DESC,updated_at DESC
      LIMIT $2`,
    [clean, limit]
  );

  if (result.rows.length) return result.rows;
  return findRelevantKnowledge("", Math.min(limit, 4));
}

export async function buildAgentSystemPrompt(searchText = "", options = {}) {
  const settings = options.settings || (await getAiAgentSettings());
  let knowledgeText = "";

  if (settings.knowledgeEnabled) {
    const entries = await findRelevantKnowledge(searchText, options.allKnowledge ? 100 : 8);
    let used = 0;
    const blocks = [];
    for (const entry of entries) {
      const block = `### ${entry.title}\n${entry.content}`;
      if (used + block.length > settings.maxKnowledgeChars) break;
      blocks.push(block);
      used += block.length;
    }
    knowledgeText = blocks.join("\n\n");
  }

  const languageRule =
    settings.languageMode === "english_only"
      ? "Always respond in English."
      : "Detect the caller’s language and reply naturally in the same language. Switch languages when the caller does.";

  return [
    `You are ${settings.agentName}, the ${settings.role} for ${settings.companyName}.`,
    `OBJECTIVE\n${settings.objective}`,
    `VOICE AND TONE\n${settings.tone}`,
    `OPERATING INSTRUCTIONS\n${settings.instructions}`,
    `SAFETY AND ACCURACY RULES\n${settings.guardrails}`,
    `LANGUAGE\n${languageRule}`,
    knowledgeText
      ? `COMPANY KNOWLEDGE\nUse the following as the source of truth. Do not claim facts that conflict with it.\n\n${knowledgeText}`
      : "COMPANY KNOWLEDGE\nNo relevant company knowledge was found. Be transparent when you are unsure.",
    "PHONE RESPONSE FORMAT\nKeep each response concise and natural for a live call. Avoid markdown, long lists, links, and unnecessary repetition.",
  ].join("\n\n");
}

export async function getAiAgentRuntime(searchText = "", options = {}) {
  const settings = await getAiAgentSettings();
  const systemPrompt = await buildAgentSystemPrompt(searchText, {
    settings,
    allKnowledge: options.allKnowledge,
  });
  return { settings, systemPrompt };
}
