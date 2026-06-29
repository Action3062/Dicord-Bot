import { config } from "./config.js";
import type { JellyfinMediaItem } from "./jellyfin.js";
import { ticketCategories, type TicketCategoryId } from "./ticket-categories.js";

// Reasoning models can be slow, but never let an OpenAI request hang a handler
// forever.
const OPENAI_TIMEOUT_MS = 60_000;

export type TicketPriority = "low" | "normal" | "high" | "urgent";

export type TicketAnalysis = {
  categoryId: TicketCategoryId;
  priority: TicketPriority;
  priorityReason: string;
  missingInfoQuestions: string[];
  shortSummary: string;
};

export type FaqDraft = {
  title: string;
  keywords: string[];
  answer: string;
};

export type AssistantContext = {
  guildName: string;
  channelName?: string;
  userTag: string;
  isTicketChannel: boolean;
  ticketSubject?: string;
  supportStatus: string;
  jellyfinStatus: string;
  activeSessions?: number;
  mediaQuery?: string;
  mediaSearchStatus: string;
  mediaItems: JellyfinMediaItem[];
  paymentUrl: string;
  faqTopics: string[];
};

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
};

export function isOpenAiAssistantReady() {
  return Boolean(config.ENABLE_AI_ASSISTANT && config.OPENAI_API_KEY);
}

export async function generateAssistantReply(question: string, context: AssistantContext) {
  if (!isOpenAiAssistantReady()) {
    throw new Error("OpenAI-Assistent ist nicht aktiviert oder OPENAI_API_KEY fehlt.");
  }

  const text = await callOpenAiText({
    instructions: [
      "Du bist HoJ, ein freundlicher deutschsprachiger Support-Bot für einen Jellyfin-Discord.",
      "Antworte knapp, hilfreich und ehrlich. Maximal 1200 Zeichen.",
      "Nutze nur die bereitgestellten Fakten. Erfinde keine Jellyfin-Daten, Downloads, Zahlungen oder Teamentscheidungen.",
      "Wenn wichtige Infos fehlen, stelle 1-3 konkrete Rückfragen statt zu raten, zum Beispiel nach App, Gerät, Jellyfin-Name oder Fehlermeldung.",
      "Fordere niemals Passwoerter, Tokens, private Zahlungsdaten oder API-Keys an.",
      "Kritische Aktionen darfst du nicht selbst behaupten. Wenn ein Bibliotheksscan sinnvoll ist, sage, dass ein Teammitglied ihn per Button starten kann."
    ].join("\n"),
    input: [
      {
        role: "developer",
        content: `Kontext:\n${JSON.stringify(buildContextPayload(context), null, 2)}`
      },
      {
        role: "user",
        content: question
      }
    ],
    maxOutputTokens: config.OPENAI_MAX_OUTPUT_TOKENS
  });

  if (!text) throw new Error("OpenAI hat keine Textantwort geliefert.");
  return text.slice(0, 1800);
}

export async function analyzeTicketInput(input: {
  subject: string;
  description?: string;
  fallbackCategoryId: string;
}) {
  if (!isOpenAiAssistantReady()) return fallbackTicketAnalysis(input);

  const text = await callOpenAiText({
    instructions: [
      "Analysiere ein Jellyfin-Support-Ticket.",
      "Antworte ausschließlich als JSON ohne Markdown.",
      "Gültige Kategorien:",
      ticketCategories.map((category) => `${category.id}: ${category.label} - ${category.description}`).join("\n"),
      "Gültige priorities: low, normal, high, urgent.",
      "urgent nur bei kompletter Unerreichbarkeit, Zahlung blockiert Zugang für viele User, Sicherheitsproblem oder starkem Serverausfall.",
      "high bei zahlungs-/zugangsrelevantem Problem oder mehreren betroffenen Usern.",
      "Stelle missingInfoQuestions nur, wenn konkrete Infos fehlen, die Support wirklich braucht.",
      "JSON-Form: {\"categoryId\":\"...\",\"priority\":\"normal\",\"priorityReason\":\"...\",\"missingInfoQuestions\":[\"...\"],\"shortSummary\":\"...\"}"
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          `Thema: ${input.subject}`,
          `Beschreibung: ${input.description || "Keine Beschreibung"}`,
          `Fallback-Kategorie: ${input.fallbackCategoryId}`
        ].join("\n")
      }
    ],
    maxOutputTokens: 500
  });

  return normalizeTicketAnalysis(parseJsonObject(text), input);
}

export async function generateTicketSummary(input: {
  subject: string;
  categoryLabel: string;
  priority?: string;
  messages: string;
}) {
  const text = await callOpenAiText({
    instructions: [
      "Fasse ein Jellyfin-Support-Ticket für das Support-Team zusammen.",
      "Deutsch, sachlich, maximal 1200 Zeichen.",
      "Struktur: Kurzlage, bisher probiert, offene Fragen, nächster sinnvoller Schritt.",
      "Erfinde nichts. Wenn etwas nicht im Verlauf steht, schreibe 'nicht genannt'."
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          `Thema: ${input.subject}`,
          `Kategorie: ${input.categoryLabel}`,
          `Prioritaet: ${input.priority ?? "normal"}`,
          "",
          "Ticketverlauf:",
          input.messages
        ].join("\n")
      }
    ],
    maxOutputTokens: 700
  });

  if (!text) throw new Error("OpenAI hat keine Ticket-Zusammenfassung geliefert.");
  return text.slice(0, 1800);
}

export async function generateReplySuggestion(input: {
  subject: string;
  categoryLabel: string;
  priority?: string;
  messages: string;
}) {
  const text = await callOpenAiText({
    instructions: [
      "Schreibe einen Antwortvorschlag für ein Support-Team in einem Jellyfin-Ticket.",
      "Die Antwort wird noch von einem Menschen freigegeben. Antworte deshalb direkt an den User, freundlich und konkret.",
      "Wenn Infos fehlen, stelle maximal 3 Rückfragen.",
      "Fordere niemals Passwoerter, Tokens, private Zahlungsdaten oder API-Keys an.",
      "Keine Behauptungen über Aktionen, die nicht im Verlauf stehen. Maximal 1200 Zeichen."
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          `Thema: ${input.subject}`,
          `Kategorie: ${input.categoryLabel}`,
          `Prioritaet: ${input.priority ?? "normal"}`,
          "",
          "Ticketverlauf:",
          input.messages
        ].join("\n")
      }
    ],
    maxOutputTokens: 700
  });

  if (!text) throw new Error("OpenAI hat keinen Antwortvorschlag geliefert.");
  return text.slice(0, 1800);
}

export async function generateFaqDraft(input: {
  subject: string;
  categoryLabel: string;
  messages: string;
}) {
  const text = await callOpenAiText({
    instructions: [
      "Erstelle aus einem geschlossenen Jellyfin-Support-Ticket einen FAQ-Entwurf.",
      "Nur wenn daraus eine wiederverwendbare, allgemeine FAQ entsteht.",
      "Antworte ausschließlich als JSON ohne Markdown.",
      "JSON-Form: {\"title\":\"...\",\"keywords\":[\"...\"],\"answer\":\"...\"}",
      "Die Antwort darf keine Usernamen, IDs, Tokens, Zahlungsdaten oder privaten Details enthalten.",
      "Wenn keine sinnvolle FAQ möglich ist: {\"title\":\"\",\"keywords\":[],\"answer\":\"\"}"
    ].join("\n"),
    input: [
      {
        role: "user",
        content: [
          `Thema: ${input.subject}`,
          `Kategorie: ${input.categoryLabel}`,
          "",
          "Ticketverlauf:",
          input.messages
        ].join("\n")
      }
    ],
    maxOutputTokens: 700
  });

  return normalizeFaqDraft(parseJsonObject(text));
}

async function callOpenAiText(options: {
  instructions: string;
  input: Array<{ role: "developer" | "user"; content: string }>;
  maxOutputTokens: number;
}) {
  if (!isOpenAiAssistantReady()) {
    throw new Error("OpenAI-Assistent ist nicht aktiviert oder OPENAI_API_KEY fehlt.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      reasoning: { effort: config.OPENAI_REASONING_EFFORT },
      max_output_tokens: options.maxOutputTokens,
      text: { verbosity: "low" },
      instructions: options.instructions,
      input: options.input
    }),
    signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS)
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`OpenAI-Anfrage fehlgeschlagen: ${response.status} ${response.statusText} ${details.slice(0, 300)}`.trim());
  }

  const data = await response.json() as OpenAiResponse;
  return extractOutputText(data).trim();
}

function buildContextPayload(context: AssistantContext) {
  return {
    server: context.guildName,
    kanal: context.channelName,
    user: context.userTag,
    ticket: context.isTicketChannel
      ? { aktiv: true, thema: context.ticketSubject ?? "Unbekannt" }
      : { aktiv: false },
    supportStatus: context.supportStatus,
    jellyfinStatus: context.jellyfinStatus,
    aktiveSessions: context.activeSessions ?? "unbekannt",
    medienSuche: {
      suchbegriff: context.mediaQuery ?? "",
      status: context.mediaSearchStatus,
      treffer: context.mediaItems.map((item) => ({
        name: item.Name ?? "Unbenannt",
        typ: item.Type ?? "Unbekannt",
        jahr: item.ProductionYear ?? "",
        premiere: item.PremiereDate ?? "",
        hinzugefügt: item.DateCreated ?? ""
      }))
    },
    zahlungsseite: context.paymentUrl,
    faqThemen: context.faqTopics
  };
}

function extractOutputText(response: OpenAiResponse) {
  if (response.output_text) return response.output_text;
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n");
}

function parseJsonObject(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const candidate = fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed;
  try {
    return JSON.parse(candidate) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeTicketAnalysis(raw: Record<string, unknown>, input: {
  subject: string;
  description?: string;
  fallbackCategoryId: string;
}) {
  const categoryIds = new Set(ticketCategories.map((category) => category.id));
  const priorities = new Set<TicketPriority>(["low", "normal", "high", "urgent"]);
  const fallback = fallbackTicketAnalysis(input);
  const categoryId = typeof raw.categoryId === "string" && categoryIds.has(raw.categoryId as TicketCategoryId)
    ? raw.categoryId as TicketCategoryId
    : fallback.categoryId;
  const priority = typeof raw.priority === "string" && priorities.has(raw.priority as TicketPriority)
    ? raw.priority as TicketPriority
    : fallback.priority;
  const questions = Array.isArray(raw.missingInfoQuestions)
    ? raw.missingInfoQuestions.filter((item): item is string => typeof item === "string").slice(0, 3)
    : fallback.missingInfoQuestions;

  return {
    categoryId,
    priority,
    priorityReason: typeof raw.priorityReason === "string" && raw.priorityReason.trim()
      ? raw.priorityReason.trim().slice(0, 240)
      : fallback.priorityReason,
    missingInfoQuestions: questions,
    shortSummary: typeof raw.shortSummary === "string" && raw.shortSummary.trim()
      ? raw.shortSummary.trim().slice(0, 240)
      : fallback.shortSummary
  } satisfies TicketAnalysis;
}

function fallbackTicketAnalysis(input: {
  subject: string;
  description?: string;
  fallbackCategoryId: string;
}) {
  const text = `${input.subject}\n${input.description ?? ""}`.toLowerCase();
  const priority: TicketPriority = /\b(dringend|urgent|offline|ausfall|bezahlt|zahlung|kein zugang|komplett)\b/.test(text)
    ? "high"
    : "normal";
  const missingInfoQuestions = [];
  if (/\b(stream|ruckelt|buffer|app|login|fehler|problem|geht nicht)\b/.test(text) && !/\b(android|ios|tv|browser|fire|app|gerät|gerät)\b/.test(text)) {
    missingInfoQuestions.push("Welche App und welches Gerät nutzt du?");
  }
  if (/\b(login|zugang|account|zahlung)\b/.test(text) && !/\bname|username|benutzer\b/.test(text)) {
    missingInfoQuestions.push("Wie lautet dein Jellyfin-Benutzername?");
  }

  return {
    categoryId: ticketCategories.find((category) => category.id === input.fallbackCategoryId)?.id ?? "sonstiges",
    priority,
    priorityReason: priority === "high" ? "Schluesselwoerter deuten auf Zugang, Zahlung oder Ausfall hin." : "Normale Support-Anfrage.",
    missingInfoQuestions,
    shortSummary: input.subject.slice(0, 160)
  } satisfies TicketAnalysis;
}

function normalizeFaqDraft(raw: Record<string, unknown>) {
  const title = typeof raw.title === "string" ? raw.title.trim().slice(0, 80) : "";
  const answer = typeof raw.answer === "string" ? raw.answer.trim().slice(0, 1200) : "";
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean).slice(0, 8)
    : [];

  return { title, keywords, answer } satisfies FaqDraft;
}
