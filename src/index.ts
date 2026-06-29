import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Guild,
  GuildMember,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  TextChannel,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type User
} from "discord.js";
import { ActivityStore, type WarningEntry, type WarningSource } from "./activity-store.js";
import { commands } from "./commands.js";
import { config } from "./config.js";
import { answerQuestion, listFaqTopics, searchFaqItems } from "./faq.js";
import { FaqStore } from "./faq-store.js";
import { checkJellyfinUser, getActiveSessionCount, getJellyfinInfo, getJellyfinLibraryStats, refreshJellyfinLibrary, searchJellyfinMedia, type JellyfinLibraryStats } from "./jellyfin.js";
import {
  analyzeTicketInput,
  generateAssistantReply,
  generateFaqDraft,
  generateReplySuggestion,
  generateTicketSummary,
  isOpenAiAssistantReady,
  type AssistantContext,
  type FaqDraft,
  type TicketAnalysis,
  type TicketPriority
} from "./openai-assistant.js";
import { flushPendingWrites } from "./persistence.js";
import { SupportStore, type SupportStatus } from "./support-store.js";
import { getTicketCategory, inferTicketCategory } from "./ticket-categories.js";
import { TicketStore, type Ticket } from "./ticket-store.js";
import { StatsStore, type StatsChannelEntry, type StatsChannelKind } from "./stats-store.js";
import { TrialStore, type TrialEntry } from "./trial-store.js";
import { SetupStore } from "./setup-store.js";
import { buildByteflixServer } from "./byteflix-setup.js";
import { createTrialAccount, isJfaGoConfigured, listJfaGoUsers } from "./jfago.js";

const store = ActivityStore.fromDataDir(config.BOT_DATA_DIR);
const ticketStore = TicketStore.fromDataDir(config.BOT_DATA_DIR);
const supportStore = SupportStore.fromDataDir(config.BOT_DATA_DIR);
const faqStore = FaqStore.fromDataDir(config.BOT_DATA_DIR);
const statsStore = StatsStore.fromDataDir(config.BOT_DATA_DIR);
const trialStore = TrialStore.fromDataDir(config.BOT_DATA_DIR);
const setupStore = SetupStore.fromDataDir(config.BOT_DATA_DIR);
type RecentUserMessage = {
  at: number;
  contentKey: string;
  linkCount: number;
  mentionCount: number;
};

const recentMessages = new Map<string, RecentUserMessage[]>();
const moderationCooldowns = new Map<string, number>();
const TICKET_CREATE_BUTTON_ID = "ticket:create";
const TICKET_CLOSE_BUTTON_ID = "ticket:close";
const TICKET_CREATE_MODAL_ID = "ticket:create-modal";
const TICKET_MODAL_SUBJECT_ID = "ticket-subject";
const TICKET_MODAL_DESCRIPTION_ID = "ticket-description";
const AI_LIBRARY_SCAN_BUTTON_ID = "ai:jellyfin-library-scan";
const AI_SUGGEST_SEND_PREFIX = "ai:suggest:send:";
const AI_SUGGEST_DISCARD_PREFIX = "ai:suggest:discard:";
const AI_FAQ_APPROVE_PREFIX = "ai:faq:approve:";
const AI_FAQ_DISCARD_PREFIX = "ai:faq:discard:";
const MODERATION_WINDOW_MS = 60_000;
const MODERATION_COOLDOWN_MS = 60_000;
const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const EPHEMERAL_PRUNE_INTERVAL_MS = 10 * 60_000;

const pendingReplySuggestions = new Map<string, {
  channelId: string;
  ticketId: string;
  text: string;
  createdBy: string;
  createdAt: number;
}>();
const pendingFaqDrafts = new Map<string, {
  draft: FaqDraft;
  ticketId: string;
  createdAt: number;
}>();

const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildModeration
];

if (config.ENABLE_MEMBER_MONITORING || config.ENABLE_NEW_ACCOUNT_PROTECTION) {
  intents.push(GatewayIntentBits.GuildMembers);
}

if (config.ENABLE_MESSAGE_QA || config.ENABLE_AI_ASSISTANT || config.ENABLE_SUPPORT_MESSAGE_CONTENT || config.ENABLE_MODERATION_CONTENT || config.ENABLE_LINK_FILTER) {
  intents.push(GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})...`);
  // Safety net: never let shutdown hang (e.g. a stuck Discord request).
  setTimeout(() => process.exit(exitCode), 5000).unref();
  try {
    await flushPendingWrites();
  } catch (flushError) {
    console.error("Error while flushing writes on shutdown", flushError);
  }
  try {
    await client.destroy();
  } catch {
    // ignore
  }
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection", error);
  void logErrorToDiscord({
    title: "Unhandled rejection",
    error
  });
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
  // The process is in an undefined state: flush pending writes, then exit so the
  // container's restart policy brings up a clean instance.
  void logErrorToDiscord({
    title: "Uncaught exception",
    error
  }).catch(() => undefined);
  void shutdown("uncaughtException", 1);
});

type SendableChannel = {
  send(payload: { content?: string; embeds?: EmbedBuilder[]; files?: AttachmentBuilder[]; components?: unknown[] }): Promise<unknown>;
};

function canSend(channel: unknown): channel is SendableChannel {
  return Boolean(channel && typeof (channel as { send?: unknown }).send === "function");
}

function ticketNumber(value: number) {
  return String(value).padStart(4, "0");
}

function supportStatusLabel(status: SupportStatus) {
  if (status === "online") return "Online";
  if (status === "busy") return "Beschäftigt";
  return "Offline";
}

function supportStatusColor(status: SupportStatus) {
  if (status === "online") return 0x2ecc71;
  if (status === "busy") return 0xf1c40f;
  return 0x95a5a6;
}

function priorityLabel(priority?: string) {
  if (priority === "urgent") return "Dringend";
  if (priority === "high") return "Hoch";
  if (priority === "low") return "Niedrig";
  return "Normal";
}

function priorityColor(priority?: string) {
  if (priority === "urgent") return 0xe74c3c;
  if (priority === "high") return 0xe67e22;
  if (priority === "low") return 0x95a5a6;
  return 0x3498db;
}

function normalizeMessageContent(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "[link]")
    .replace(/www\.\S+/g, "[link]")
    .replace(/\s+/g, " ")
    .trim();
}

function countLinks(value: string) {
  return value.match(/(?:https?:\/\/|www\.)\S+/gi)?.length ?? 0;
}

function extractLinkHost(raw: string) {
  return raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
}

// True if the message contains at least one link whose host is not on LINK_WHITELIST.
function messageHasBlockedLink(content: string) {
  const matches = content.match(/(?:https?:\/\/|www\.)\S+/gi);
  if (!matches) return false;
  const whitelist = config.LINK_WHITELIST.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return matches.some((raw) => {
    const host = extractLinkHost(raw);
    return !whitelist.some((domain) => host === domain || host.endsWith(`.${domain}`));
  });
}

function findDiscordInviteCodes(value: string) {
  const codes = new Set<string>();
  const regex = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    codes.add(match[1]);
  }
  return [...codes];
}

function looksLikeCapsSpam(value: string) {
  // Unicode-aware so German umlauts (ä/ö/ü) and other accented letters count too.
  // A char is "uppercase" only if it has a distinct lowercase form and already
  // equals its own uppercase form (ß stays lowercase, digits/symbols are ignored).
  const letters = [...value].filter((char) => /\p{L}/u.test(char));
  if (letters.length < 12) return false;
  const uppercase = letters.filter((char) => char !== char.toLowerCase() && char === char.toUpperCase()).length;
  return uppercase / letters.length >= 0.75;
}

function messageEvidence(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function accountAgeDays(user: User) {
  return Math.max(0, Math.floor((Date.now() - user.createdTimestamp) / 86_400_000));
}

function isNewAccount(user: User) {
  return accountAgeDays(user) < config.NEW_ACCOUNT_WARN_DAYS;
}

function isStrictNewAccount(user: User) {
  return accountAgeDays(user) < config.NEW_ACCOUNT_STRICT_DAYS;
}

function scamPhraseMatches(value: string, hasLink: boolean, strictForNewAccount: boolean) {
  const normalized = value.toLowerCase();
  const matches: string[] = [];

  const patterns = [
    { label: "Free Nitro", regex: /\b(free|gratis|kostenlos).{0,30}(nitro|discord nitro)\b/i },
    { label: "Steam Gift", regex: /\b(steam|gift|geschenk).{0,40}(claim|holen|abholen|kostenlos|free|gratis)\b/i },
    { label: "Wallet/Seed Scam", regex: /\b(seed phrase|private key|wallet verification|verify wallet|metamask|airdrop)\b/i },
    { label: "Account Verification", regex: /\b(verify account|konto verifizieren|account verifizieren|security check)\b/i },
    { label: "Claim/Reward", regex: /\b(claim now|claim reward|jetzt sichern|belohnung abholen|preis abholen)\b/i }
  ];

  for (const pattern of patterns) {
    if (pattern.regex.test(value)) matches.push(pattern.label);
  }

  if (hasLink && /\b(giveaway|verlosung|gewinnspiel|prize|reward|bonus)\b/i.test(value)) {
    matches.push("Giveaway-Link");
  }

  if (strictForNewAccount && hasLink && /\b(nitro|steam|gift|crypto|wallet|airdrop|verify|claim|gratis|kostenlos|gewinn|prize|bonus)\b/i.test(normalized)) {
    matches.push("Neuer Account mit riskantem Link");
  }

  return [...new Set(matches)];
}

function stripBotMention(value: string) {
  if (!client.user) return value;
  return value
    .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
    .replace(/^jellybot\s+/i, "")
    .trim();
}

function readableChannelName(channel: unknown) {
  const name = channel && typeof channel === "object" && "name" in channel
    ? (channel as { name?: string | null }).name
    : undefined;
  return name ?? undefined;
}

async function sendTypingIfPossible(channel: unknown) {
  const sendTyping = channel && typeof channel === "object" && "sendTyping" in channel
    ? (channel as { sendTyping?: () => Promise<unknown> }).sendTyping
    : undefined;
  await sendTyping?.call(channel).catch(() => undefined);
}

function extractMediaQuery(value: string) {
  const quoted = value.match(/["'`„“”]([^"'`„“”]{2,80})["'`„“”]/);
  if (quoted?.[1]) return quoted[1].trim();

  const afterType = value.match(/\b(?:film|serie|staffel|media|medium)\s+(.{2,80})/i)?.[1];
  const raw = afterType ?? value;
  const cleaned = raw
    .replace(/<@!?\d+>/g, " ")
    .replace(/[?.!,;:()[\]{}]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => ![
      "warum", "wieso", "wann", "wo", "ist", "sind", "der", "die", "das", "den", "dem", "ein", "eine",
      "noch", "nicht", "da", "drauf", "auf", "jellyfin", "film", "serie", "staffel", "kommt", "kommen",
      "gibt", "es", "kannst", "du", "mal", "bitte", "prüfen", "prüfen", "laden", "neu", "reload", "fehlt"
    ].includes(word.toLowerCase()))
    .join(" ")
    .trim();

  return cleaned.length >= 2 && cleaned.length <= 80 ? cleaned : undefined;
}

function looksLikeMediaQuestion(value: string) {
  return /\b(film|serie|staffel|medien|jellyfin|bibliothek|scan|reload|fehlt|nicht da|noch nicht|warum|wieso)\b/i.test(value);
}

function assistantActionComponents(question: string, context: AssistantContext) {
  if (!config.JELLYFIN_BASE_URL || !config.JELLYFIN_API_KEY) return [];
  if (!looksLikeMediaQuestion(question) && !context.mediaQuery) return [];

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(AI_LIBRARY_SCAN_BUTTON_ID)
        .setLabel("Bibliothek scannen")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function canWarnForRule(userId: string, rule: string) {
  const key = `${userId}:${rule}`;
  const now = Date.now();
  const previous = moderationCooldowns.get(key) ?? 0;
  if (now - previous < MODERATION_COOLDOWN_MS) return false;
  moderationCooldowns.set(key, now);
  return true;
}

function escalationTimeoutMinutes(activeWarnings: number) {
  if (activeWarnings < config.WARNINGS_BEFORE_TIMEOUT) return 0;
  const level = activeWarnings - config.WARNINGS_BEFORE_TIMEOUT;
  const multiplier = level <= 0 ? 1 : level === 1 ? 3 : 6;
  return Math.min(config.TIMEOUT_MINUTES * multiplier, 10080);
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "user";
}

function channelNameKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "");
}

function paymentUrl() {
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/pay`;
}

function ticketEntryEmbed() {
  return new EmbedBuilder()
    .setTitle("Support-Tickets")
    .setDescription([
      "Bitte öffne für Support ein privates Ticket.",
      "",
      "**So geht es:**",
      "1. Klicke unten auf `Ticket öffnen`.",
      "2. Fuell das kurze Formular aus.",
      "3. Der Bot erstellt daraus ein privates Ticket.",
      "",
      "Slash-Command als Backup: `/ticket create` funktioniert nur in diesem Kanal.",
      "Alternativ kannst du hier eine Nachricht schreiben. Der Bot erstellt daraus automatisch ein Ticket und entfernt die Nachricht aus diesem Eingangskanal.",
      "",
      "Bitte poste hier keine Passwoerter, Tokens oder privaten Zahlungsdaten."
    ].join("\n"))
    .setColor(0x3498db)
    .setFooter({ text: "HOJ_TICKET_ENTRY" });
}

function ticketEntryComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(TICKET_CREATE_BUTTON_ID)
        .setLabel("Ticket öffnen")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

// Roles that count as support team when no explicit DISCORD_SUPPORT_ROLE_ID /
// DISCORD_ADMIN_ROLE_ID is configured. Kept as a documented fallback (see README);
// for stable, rename-proof authorization configure the role IDs in .env instead.
const TEAM_ROLE_NAMES = ["Support", "Moderator", "Admin"] as const;

function isModerator(member: GuildMember) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ModerateMembers)) return true;
  if (config.DISCORD_ADMIN_ROLE_ID && member.roles.cache.has(config.DISCORD_ADMIN_ROLE_ID)) return true;
  if (config.DISCORD_SUPPORT_ROLE_ID && member.roles.cache.has(config.DISCORD_SUPPORT_ROLE_ID)) return true;
  return false;
}

function hasNamedRole(member: GuildMember, names: string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return member.roles.cache.some((role) => wanted.has(role.name.toLowerCase()));
}

function isTicketTeamMember(member: GuildMember) {
  return isModerator(member) || hasNamedRole(member, [...TEAM_ROLE_NAMES]);
}

// Defence-in-depth: setDefaultMemberPermissions() in commands.ts is only a client
// hint that a guild admin can override in the Integrations settings. Privileged
// command handlers re-check the permission at runtime so a misconfigured guild
// can never expose them to non-moderators.
function memberHasGuildPermission(member: GuildMember, permission: bigint) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(permission)) return true;
  if (config.DISCORD_ADMIN_ROLE_ID && member.roles.cache.has(config.DISCORD_ADMIN_ROLE_ID)) return true;
  return false;
}

async function ensureCommandPermission(
  interaction: ChatInputCommandInteraction,
  check: (member: GuildMember) => boolean
) {
  const member = await getInteractionMember(interaction);
  if (member && check(member)) return true;
  const content = "Dir fehlt die Berechtigung für diesen Befehl.";
  if (interaction.deferred || interaction.replied) await interaction.editReply(content);
  else await interaction.reply({ ephemeral: true, content });
  return false;
}

async function getInteractionMember(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return null;
  if (interaction.member instanceof GuildMember) return interaction.member;
  return interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}

async function logToDiscord(guild: Guild, embed: EmbedBuilder) {
  const configured = config.DISCORD_LOG_CHANNEL_ID
    ? await guild.channels.fetch(config.DISCORD_LOG_CHANNEL_ID).catch(() => null)
    : null;
  const fallback = configured ?? guild.channels.cache.find((channel) =>
    channel.isTextBased() && ["mod-log", "logs", "bot-log"].includes(channel.name)
  );

  if (canSend(fallback)) {
    await fallback.send({ embeds: [embed] }).catch(() => undefined);
  }
}

function redactSensitive(value: string) {
  let redacted = value;
  for (const secret of [config.DISCORD_TOKEN, config.OPENAI_API_KEY, config.JELLYFIN_API_KEY, config.JFA_GO_ADMIN_PASSWORD]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }

  return redacted
    .replace(/Bot\s+[A-Za-z0-9._-]+/g, "Bot [redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]")
    .replace(/(x-emby-token["'\s:=]+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
}

function errorToText(error: unknown) {
  if (error instanceof Error) {
    return redactSensitive(error.stack || error.message || error.name);
  }

  try {
    return redactSensitive(JSON.stringify(error, null, 2));
  } catch {
    return redactSensitive(String(error));
  }
}

function codeBlock(value: string, maxLength = 3500) {
  const safe = value.replace(/```/g, "'''").slice(0, maxLength);
  return `\`\`\`\n${safe || "Kein Fehlertext"}\n\`\`\``;
}

async function logErrorToDiscord(options: {
  guild?: Guild | null;
  title: string;
  error: unknown;
  context?: Record<string, string | number | boolean | null | undefined>;
}) {
  const embed = new EmbedBuilder()
    .setTitle(`Bot-Fehler: ${options.title}`.slice(0, 256))
    .setDescription(codeBlock(errorToText(options.error)))
    .setColor(0xe74c3c)
    .setTimestamp();

  const fields = Object.entries(options.context ?? {})
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .slice(0, 8)
    .map(([name, value]) => ({
      name: name.slice(0, 256),
      value: String(value).slice(0, 1024),
      inline: true
    }));
  if (fields.length) embed.addFields(fields);

  const guilds = options.guild ? [options.guild] : [...client.guilds.cache.values()];
  for (const guild of guilds) {
    await logToDiscord(guild, embed).catch((logError) => {
      console.error("Discord error logging failed", logError);
    });
  }
}

async function warnAndEscalate(options: {
  guild: Guild;
  member: GuildMember;
  reason: string;
  source: WarningSource;
  moderatorId: string;
  channelId?: string;
  messageId?: string;
  evidence?: string;
}) {
  const { entry, total } = await store.addWarning(options.member.id, {
    reason: options.reason,
    moderatorId: options.moderatorId,
    source: options.source,
    channelId: options.channelId,
    messageId: options.messageId,
    evidence: options.evidence
  });

  const timeoutMinutes = escalationTimeoutMinutes(total);
  let timeoutApplied = false;
  if (timeoutMinutes > 0 && options.member.moderatable) {
    await options.member.timeout(
      timeoutMinutes * 60_000,
      `Automatische Eskalation nach ${total} aktiven Warnungen`
    ).catch(() => undefined);
    timeoutApplied = true;
  }

  await logToDiscord(options.guild, new EmbedBuilder()
    .setTitle(options.source === "auto" ? "Automatische Warnung" : "Manuelle Warnung")
    .setDescription(`<@${options.member.id}> wurde verwarnt.`)
    .addFields(
      { name: "Grund", value: options.reason.slice(0, 1024) },
      { name: "Warnungen", value: String(total), inline: true },
      { name: "ID", value: entry.id, inline: true },
      { name: "Eskalation", value: timeoutApplied ? `Timeout: ${timeoutMinutes} Minuten` : "Keine", inline: true }
    )
    .setColor(options.source === "auto" ? 0xf1c40f : 0xe67e22)
    .setTimestamp());

  return { entry, total, timeoutMinutes, timeoutApplied };
}

async function moderationMember(message: Message) {
  if (!message.guild) return null;
  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || isModerator(member)) return null;
  return member;
}

async function handleInviteProtectionMessage(message: Message) {
  if (!config.ENABLE_INVITE_LINK_PROTECTION || !message.guild || !message.content) return false;
  const codes = findDiscordInviteCodes(message.content);
  if (!codes.length) return false;

  const member = await moderationMember(message);
  if (!member) return false;

  for (const code of codes) {
    const invite = await client.fetchInvite(code).catch(() => null);
    const inviteGuildId = invite?.guild?.id;
    if (inviteGuildId === message.guild.id) continue;

    await message.delete().catch(() => undefined);
    if (canWarnForRule(message.author.id, "foreign_invite")) {
      const reason = inviteGuildId
        ? "Fremder Discord-Invite gepostet"
        : "Unbekannter oder ungültiger Discord-Invite gepostet";
      const result = await warnAndEscalate({
        guild: message.guild,
        member,
        reason,
        source: "auto",
        moderatorId: client.user?.id ?? "bot",
        channelId: message.channelId,
        messageId: message.id,
        evidence: code
      });
      if (canSend(message.channel)) {
        await message.channel.send({
          content: `<@${message.author.id}> fremde Discord-Einladungen sind hier nicht erlaubt. Warnungen: ${result.total}`
        }).catch(() => undefined);
      }
    }
    return true;
  }

  return false;
}

async function handleScamPhraseMessage(message: Message) {
  if (!config.ENABLE_SCAM_PHRASE_PROTECTION || !message.guild || !message.content) return false;

  const member = await moderationMember(message);
  if (!member) return false;

  const hasLink = countLinks(message.content) > 0;
  const matches = scamPhraseMatches(message.content, hasLink, isStrictNewAccount(message.author));
  if (!matches.length) return false;

  await message.delete().catch(() => undefined);
  if (!canWarnForRule(message.author.id, "scam_phrase")) return true;

  const reason = `Mögliche Scam-/Phishing-Nachricht: ${matches.join(", ")}`;
  const result = await warnAndEscalate({
    guild: message.guild,
    member,
    reason,
    source: "auto",
    moderatorId: client.user?.id ?? "bot",
    channelId: message.channelId,
    messageId: message.id,
    evidence: messageEvidence(message.content)
  });

  if (canSend(message.channel)) {
    await message.channel.send({
      content: `<@${message.author.id}> diese Nachricht wurde als möglicher Scam gelöscht. Warnungen: ${result.total}`
    }).catch(() => undefined);
  }

  return true;
}

// Members (and above) may post links; only users without a member-level role are filtered.
function memberHasMemberStatus(member: GuildMember) {
  if (config.DISCORD_MEMBER_ROLE_ID && member.roles.cache.has(config.DISCORD_MEMBER_ROLE_ID)) return true;
  const markers = ["mitglied", "trial", "abonnent", "premium"];
  return member.roles.cache.some((role) => markers.some((marker) => role.name.toLowerCase().includes(marker)));
}

async function handleLinkFilterMessage(message: Message) {
  if (!config.ENABLE_LINK_FILTER || !message.guild) return false;
  if (!messageHasBlockedLink(message.content)) return false;
  const member = await moderationMember(message);
  if (!member) return false; // team/mods are exempt
  if (memberHasMemberStatus(member)) return false; // members and above may post links
  await message.delete().catch(() => undefined);
  if (canWarnForRule(message.author.id, "link_filter") && canSend(message.channel)) {
    const notice = await (message.channel as TextChannel)
      .send({ content: `<@${message.author.id}> Links sind hier nicht erlaubt.` })
      .catch(() => null);
    if (notice) setTimeout(() => void notice.delete().catch(() => undefined), 8000).unref();
  }
  return true;
}

async function handleAdvancedAntiSpamMessage(message: Message) {
  if (!config.ENABLE_ADVANCED_ANTI_SPAM || !message.guild) return false;

  const member = await moderationMember(message);
  if (!member) return false;

  const now = Date.now();
  const content = message.content.trim();
  const contentKey = normalizeMessageContent(content);
  const linkCount = countLinks(content);
  const mentionCount =
    message.mentions.users.size +
    message.mentions.roles.size +
    (message.mentions.everyone ? 5 : 0);
  const previous = (recentMessages.get(message.author.id) ?? [])
    .filter((item) => now - item.at <= MODERATION_WINDOW_MS);
  const current: RecentUserMessage = { at: now, contentKey, linkCount, mentionCount };
  const recent = [...previous, current];
  recentMessages.set(message.author.id, recent);

  const repeatCount = contentKey.length >= 6
    ? recent.filter((item) => item.contentKey === contentKey).length
    : 0;
  const linkMessages = recent.filter((item) => item.linkCount > 0).length;
  const recentLinkCount = recent.reduce((sum, item) => sum + item.linkCount, 0);
  const recentMentionCount = recent.reduce((sum, item) => sum + item.mentionCount, 0);
  const strictNewAccount = isStrictNewAccount(message.author);

  const reasons: string[] = [];
  const rules: string[] = [];
  if (recent.length > config.MAX_MESSAGES_PER_MINUTE) {
    rules.push("message_rate");
    reasons.push(`${recent.length} Nachrichten in kurzer Zeit`);
  }
  if (repeatCount >= 3) {
    rules.push("repeated_message");
    reasons.push("Wiederholte gleiche Nachricht");
  }
  if (content && looksLikeCapsSpam(content)) {
    rules.push("caps_spam");
    reasons.push("Zu viel Großschreibung");
  }
  if (linkCount >= 3 || linkMessages >= 4 || recentLinkCount >= 6) {
    rules.push("link_spam");
    reasons.push("Zu viele Links in kurzer Zeit");
  }
  if (mentionCount >= 5 || recentMentionCount >= 8) {
    rules.push("mention_spam");
    reasons.push("Zu viele Mentions in kurzer Zeit");
  }
  if (strictNewAccount && linkCount > 0) {
    rules.push("new_account_link");
    reasons.push(`Sehr neuer Account (${accountAgeDays(message.author)} Tage) mit Link`);
  }
  if (strictNewAccount && mentionCount >= 2) {
    rules.push("new_account_mentions");
    reasons.push(`Sehr neuer Account (${accountAgeDays(message.author)} Tage) mit mehreren Mentions`);
  }

  if (!rules.length) return false;

  await message.delete().catch(() => undefined);
  const rule = rules[0];
  if (!canWarnForRule(message.author.id, rule)) return true;

  const result = await warnAndEscalate({
    guild: message.guild,
    member,
    reason: reasons.join("; "),
    source: "auto",
    moderatorId: client.user?.id ?? "bot",
    channelId: message.channelId,
    messageId: message.id,
    evidence: messageEvidence(content)
  });

  if (canSend(message.channel)) {
    await message.channel.send({
      content: `<@${message.author.id}> bitte Spam vermeiden. Grund: ${reasons[0]}. Warnungen: ${result.total}`
    }).catch(() => undefined);
  }

  return true;
}

async function logTicket(guild: Guild, embed: EmbedBuilder) {
  const configured = config.DISCORD_TICKET_LOG_CHANNEL_ID
    ? await guild.channels.fetch(config.DISCORD_TICKET_LOG_CHANNEL_ID).catch(() => null)
    : null;

  if (canSend(configured)) {
    await configured.send({ embeds: [embed] }).catch(() => undefined);
    return;
  }

  await logToDiscord(guild, embed);
}

async function sendTicketLogPayload(guild: Guild, payload: { embeds?: EmbedBuilder[]; content?: string; components?: unknown[]; files?: AttachmentBuilder[] }) {
  const configured = config.DISCORD_TICKET_LOG_CHANNEL_ID
    ? await guild.channels.fetch(config.DISCORD_TICKET_LOG_CHANNEL_ID).catch(() => null)
    : null;
  const fallback = configured ?? guild.channels.cache.find((channel) =>
    channel.isTextBased() && ["support-log", "ticket-log", "mod-log", "bot-log"].includes(channel.name)
  );

  if (canSend(fallback)) {
    await fallback.send(payload).catch(() => undefined);
    return true;
  }

  if (payload.embeds?.[0]) await logToDiscord(guild, payload.embeds[0]);
  return false;
}

async function logTicketWithTranscript(guild: Guild, embed: EmbedBuilder, transcriptPath?: string) {
  const configured = config.DISCORD_TICKET_LOG_CHANNEL_ID
    ? await guild.channels.fetch(config.DISCORD_TICKET_LOG_CHANNEL_ID).catch(() => null)
    : null;
  const fallback = configured ?? guild.channels.cache.find((channel) =>
    channel.isTextBased() && ["support-log", "ticket-log", "mod-log", "bot-log"].includes(channel.name)
  );

  if (!canSend(fallback)) {
    await logToDiscord(guild, embed);
    return;
  }

  const files = transcriptPath ? [new AttachmentBuilder(transcriptPath)] : undefined;
  await fallback.send({ embeds: [embed], files }).catch(() => undefined);
}

function settledStatus<T>(result: PromiseSettledResult<T>, ok: (value: T) => string, fallback: string) {
  return result.status === "fulfilled" ? ok(result.value) : fallback;
}

async function buildAssistantContext(options: {
  guild: Guild;
  channelId: string;
  channelName?: string;
  user: User;
  question: string;
}) {
  const mediaQuery = extractMediaQuery(options.question);
  const [jellyfin, sessions, supportState, ticket, media, faqTopics] = await Promise.allSettled([
    getJellyfinInfo(),
    getActiveSessionCount(),
    supportStore.get(),
    ticketStore.getByChannel(options.guild.id, options.channelId),
    mediaQuery ? searchJellyfinMedia(mediaQuery) : Promise.resolve(undefined),
    allFaqTopics()
  ]);

  const ticketValue = ticket.status === "fulfilled" ? ticket.value : undefined;
  const supportValue = supportState.status === "fulfilled" ? supportState.value : undefined;
  const mediaValue = media.status === "fulfilled" ? media.value : undefined;

  return {
    guildName: options.guild.name,
    channelName: options.channelName,
    userTag: options.user.tag,
    isTicketChannel: Boolean(ticketValue?.status === "open"),
    ticketSubject: ticketValue?.subject,
    supportStatus: supportValue
      ? `${supportStatusLabel(supportValue.status)}: ${supportValue.message}`
      : "Unbekannt",
    jellyfinStatus: settledStatus(jellyfin, (value) =>
      value.configured
        ? `${value.info.ServerName ?? "Jellyfin"} ${value.info.Version ?? ""}`.trim()
        : "Nicht konfiguriert", "Nicht erreichbar"),
    activeSessions: sessions.status === "fulfilled" ? sessions.value : undefined,
    mediaQuery,
    mediaSearchStatus: mediaValue
      ? mediaValue.configured
        ? `${mediaValue.total} Treffer`
        : "Jellyfin API-Key fehlt oder ist nicht konfiguriert"
      : mediaQuery
        ? "Suche fehlgeschlagen oder ohne Ergebnis"
        : "Nicht gesucht",
    mediaItems: mediaValue?.items ?? [],
    paymentUrl: paymentUrl(),
    faqTopics: faqTopics.status === "fulfilled" ? faqTopics.value : listFaqTopics()
  } satisfies AssistantContext;
}

// Every AI-generated answer is posted without human review, so it carries a
// visible disclaimer making clear it is machine-generated and not binding. The
// "-#" prefix renders as Discord subtext (small, muted).
const AI_ANSWER_DISCLAIMER =
  "\n\n-# KI-generierte Antwort - ohne Gewaehr. Bei wichtigen oder verbindlichen Fragen bitte ein Ticket öffnen.";

async function answerWithAiAssistant(options: {
  guild: Guild;
  channelId: string;
  channelName?: string;
  user: User;
  question: string;
  reply: (payload: { content: string; components?: ActionRowBuilder<ButtonBuilder>[] }) => Promise<unknown>;
}) {
  if (!isOpenAiAssistantReady()) return false;
  const context = await buildAssistantContext(options);
  const answer = await generateAssistantReply(options.question, context);
  await options.reply({
    content: `${answer}${AI_ANSWER_DISCLAIMER}`,
    components: assistantActionComponents(options.question, context)
  });
  return true;
}

async function allFaqTopics() {
  const dynamic = await faqStore.list();
  return [...new Set([...listFaqTopics(), ...dynamic.map((item) => item.title)])];
}

async function searchAllFaqItems(input: string, limit = 8) {
  const staticItems = searchFaqItems(input, limit);
  const dynamicItems = await faqStore.search(input, limit);
  const byTitle = new Map<string, typeof staticItems[number]>();
  for (const item of [...staticItems, ...dynamicItems]) {
    byTitle.set(item.title.toLowerCase(), item);
  }
  return [...byTitle.values()].slice(0, limit);
}

async function answerAnyQuestion(input: string) {
  return answerQuestion(input) ?? await faqStore.answer(input);
}

function ticketTeamRoleIds(guild: Guild) {
  const ids = new Set<string>();
  for (const roleId of [config.DISCORD_SUPPORT_ROLE_ID, config.DISCORD_ADMIN_ROLE_ID]) {
    if (roleId && guild.roles.cache.has(roleId)) ids.add(roleId);
  }

  for (const name of TEAM_ROLE_NAMES) {
    const role = guild.roles.cache.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (role) ids.add(role.id);
  }

  return [...ids];
}

function ticketPermissionOverwrites(guild: Guild, ownerId?: string, participantIds: string[] = []) {
  const userAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands
  ];

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: client.user?.id ?? guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels
      ]
    },
    ...ticketTeamRoleIds(guild).map((roleId) => ({
      id: roleId,
      allow: userAllow
    }))
  ];

  if (ownerId) overwrites.push({ id: ownerId, allow: userAllow });
  for (const participantId of participantIds) {
    if (participantId !== ownerId) overwrites.push({ id: participantId, allow: userAllow });
  }

  return overwrites;
}

async function ensureTicketCategory(guild: Guild) {
  if (config.DISCORD_TICKET_CATEGORY_ID) {
    const configured = await guild.channels.fetch(config.DISCORD_TICKET_CATEGORY_ID).catch(() => null);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  const storedId = await setupStore.getId(guild.id, "category:tickets");
  if (storedId) {
    const stored = await guild.channels.fetch(storedId).catch(() => null);
    if (stored?.type === ChannelType.GuildCategory) return stored;
  }

  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === "tickets"
  );
  if (existing?.type === ChannelType.GuildCategory) {
    await setupStore.setId(guild.id, "category:tickets", existing.id);
    return existing;
  }

  const createdCategory = await guild.channels.create({
    name: "TICKETS",
    type: ChannelType.GuildCategory,
    permissionOverwrites: ticketPermissionOverwrites(guild),
    reason: "Jellyfin ticket system setup"
  });
  await setupStore.setId(guild.id, "category:tickets", createdCategory.id);
  return createdCategory;
}

async function ensureTicketArchiveCategory(guild: Guild) {
  if (config.DISCORD_TICKET_ARCHIVE_CATEGORY_ID) {
    const configured = await guild.channels.fetch(config.DISCORD_TICKET_ARCHIVE_CATEGORY_ID).catch(() => null);
    if (configured?.type === ChannelType.GuildCategory) return configured;
  }

  const storedId = await setupStore.getId(guild.id, "category:archive");
  if (storedId) {
    const stored = await guild.channels.fetch(storedId).catch(() => null);
    if (stored?.type === ChannelType.GuildCategory) return stored;
  }

  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && ["archiv", "archive"].includes(channel.name.toLowerCase())
  );
  if (existing?.type === ChannelType.GuildCategory) {
    await setupStore.setId(guild.id, "category:archive", existing.id);
    return existing;
  }

  const createdCategory = await guild.channels.create({
    name: "ARCHIV",
    type: ChannelType.GuildCategory,
    permissionOverwrites: ticketPermissionOverwrites(guild),
    reason: "Ticket-Archiv setup"
  }).catch(() => null);
  if (createdCategory) await setupStore.setId(guild.id, "category:archive", createdCategory.id);
  return createdCategory;
}

async function findTicketEntryChannel(guild: Guild) {
  if (config.DISCORD_TICKET_ENTRY_CHANNEL_ID) {
    const configured = await guild.channels.fetch(config.DISCORD_TICKET_ENTRY_CHANNEL_ID).catch(() => null);
    if (configured?.type === ChannelType.GuildText) return configured;
  }

  const byteflixEntryId = await setupStore.getId(guild.id, "byteflix:channel:support-erstellen");
  if (byteflixEntryId) {
    const byteflixEntry = await guild.channels.fetch(byteflixEntryId).catch(() => null);
    if (byteflixEntry?.type === ChannelType.GuildText) return byteflixEntry;
  }

  await guild.channels.fetch().catch(() => null);
  const support = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText &&
    (channel.name.toLowerCase() === "support" || channelNameKey(channel.name) === "support")
  );
  if (support?.type === ChannelType.GuildText) return support;

  return undefined;
}

async function isTicketEntryChannel(guild: Guild, channelId: string) {
  const entryChannel = await findTicketEntryChannel(guild);
  return entryChannel?.id === channelId;
}

async function ensureTicketEntryInstructions(guild: Guild) {
  const channel = await findTicketEntryChannel(guild);
  if (!channel) return false;

  await channel.setTopic("Ticket-Eingang: Button Ticket öffnen, /ticket create oder Nachricht nutzen.").catch(() => undefined);

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const matchesInstruction = (message: Message) =>
    message.author.id === client.user?.id &&
    (
      message.embeds.some((embed) => embed.footer?.text === "HOJ_TICKET_ENTRY") ||
      message.content.startsWith("[HOJ_SETUP_SUPPORT]") ||
      message.content.startsWith("**Support")
    );
  const matches = Array.from(recent?.filter(matchesInstruction).values() ?? [])
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  const existing = matches[0];
  for (const duplicate of matches.slice(1).values()) {
    await duplicate.delete().catch(() => undefined);
  }

  if (existing) {
    await existing.edit({ content: "", embeds: [ticketEntryEmbed()], components: ticketEntryComponents() }).catch(() => undefined);
    await existing.pin().catch(() => undefined);
    return true;
  }

  const sent = await channel.send({ embeds: [ticketEntryEmbed()], components: ticketEntryComponents() }).catch(() => null);
  await sent?.pin().catch(() => undefined);
  return Boolean(sent);
}

async function getExistingOpenTickets(guild: Guild, userId: string) {
  const openTickets = await ticketStore.getOpenByOwner(guild.id, userId);
  const existingOpenTickets: Ticket[] = [];
  for (const ticket of openTickets) {
    const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
    if (channel) existingOpenTickets.push(ticket);
    else await ticketStore.close(ticket.id, client.user?.id ?? "bot", "Ticket-Kanal fehlt");
  }

  return existingOpenTickets;
}

// Serialise ticket creation per (guild,user) so two near-simultaneous requests
// (e.g. double-clicking the panel button) can't both pass the open-ticket limit
// check before either has created its channel (TOCTOU).
const ticketCreationChains = new Map<string, Promise<unknown>>();

function withTicketCreationLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = ticketCreationChains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  function cleanup() {
    if (ticketCreationChains.get(key) === tracked) ticketCreationChains.delete(key);
  }
  const tracked = run.then(cleanup, cleanup);
  ticketCreationChains.set(key, tracked);
  return run;
}

async function createTicketWithLimit(
  guild: Guild,
  userId: string,
  options: Parameters<typeof createTicketForUser>[0]
): Promise<
  | { limited: true; existing: Ticket }
  | { limited: false; result: Awaited<ReturnType<typeof createTicketForUser>> }
> {
  return withTicketCreationLock(`${guild.id}:${userId}`, async () => {
    const existingOpenTickets = await getExistingOpenTickets(guild, userId);
    if (existingOpenTickets.length >= config.MAX_OPEN_TICKETS_PER_USER) {
      return { limited: true as const, existing: existingOpenTickets[0] };
    }
    const result = await createTicketForUser(options);
    return { limited: false as const, result };
  });
}

async function recordTicketChannelActivity(message: Message) {
  if (!message.guild || message.author.bot) return;
  const ticket = await ticketStore.getByChannel(message.guild.id, message.channelId);
  if (!ticket || ticket.status !== "open") return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  const authorType = member && isTicketTeamMember(member) ? "team" : "user";
  await ticketStore.recordMessage(ticket.id, authorType);
}

function ticketWaitingSince(ticket: Ticket) {
  const lastUserMessageAt = ticket.lastUserMessageAt ?? ticket.createdAt;
  const lastTeamMessageAt = ticket.lastTeamMessageAt;
  if (lastTeamMessageAt && new Date(lastTeamMessageAt).getTime() >= new Date(lastUserMessageAt).getTime()) return undefined;
  if (ticket.lastFollowUpAt && new Date(ticket.lastFollowUpAt).getTime() >= new Date(lastUserMessageAt).getTime()) return undefined;

  const dueAt = new Date(lastUserMessageAt).getTime() + config.TICKET_FOLLOWUP_HOURS * 60 * 60 * 1000;
  return Date.now() >= dueAt ? lastUserMessageAt : undefined;
}

async function checkTicketFollowUps() {
  if (!config.ENABLE_TICKET_FOLLOWUPS) return;

  for (const guild of client.guilds.cache.values()) {
    const tickets = await ticketStore.listOpen(guild.id);
    for (const ticket of tickets) {
      const waitingSince = ticketWaitingSince(ticket);
      if (!waitingSince) continue;

      const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
      if (!canSend(channel)) continue;

      const teamMentions = ticketTeamRoleIds(guild).map((roleId) => `<@&${roleId}>`).join(" ");
      const sent = await channel.send({
        content: teamMentions || undefined,
        embeds: [new EmbedBuilder()
          .setTitle("Ticket wartet auf Antwort")
          .setDescription([
            `Dieses Ticket wartet seit <t:${Math.floor(new Date(waitingSince).getTime() / 1000)}:R> auf eine Team-Antwort.`,
            "",
            "Bitte kurz reagieren, eine Rückfrage stellen oder das Ticket schließen, wenn es erledigt ist."
          ].join("\n"))
          .addFields(
            { name: "Ticket", value: `#${ticketNumber(ticket.number)} ${ticket.subject}`, inline: true },
            { name: "User", value: `<@${ticket.ownerId}>`, inline: true }
          )
          .setColor(0xf1c40f)
          .setTimestamp()]
      }).catch(() => null);
      if (!sent) continue;
      await ticketStore.markFollowUp(ticket.id);
      await logTicket(guild, new EmbedBuilder()
        .setTitle("Ticket-Follow-up gesendet")
        .setDescription(`<#${ticket.channelId}> wartet seit mehr als ${config.TICKET_FOLLOWUP_HOURS} Stunden auf eine Team-Antwort.`)
        .addFields({ name: "Ticket", value: `#${ticketNumber(ticket.number)} ${ticket.subject}` })
        .setColor(0xf1c40f)
        .setTimestamp());
    }
  }
}

async function lockTicketChannel(ticket: Ticket, reason?: string) {
  const guild = client.guilds.cache.get(ticket.guildId);
  const channel = guild ? await guild.channels.fetch(ticket.channelId).catch(() => null) : null;
  if (!channel) return;

  const typedChannel = channel as unknown as {
    setName?: (name: string, reason?: string) => Promise<unknown>;
    setParent?: (parentId: string, options?: { lockPermissions?: boolean; reason?: string }) => Promise<unknown>;
    permissionOverwrites?: {
      edit: (id: string, options: Record<string, boolean>, reason?: string) => Promise<unknown>;
    };
  };

  // A failure here means a "closed" ticket may still be writable by its owner, so
  // surface it in the logs instead of swallowing it silently. We still don't throw:
  // a partial lock should not abort the rest of the close flow (transcript, log).
  const logLockFailure = (action: string) => (error: unknown) => {
    console.error(`[ticket] lockTicketChannel: ${action} failed for ticket ${ticket.id}`, error);
  };

  await typedChannel.permissionOverwrites?.edit(ticket.ownerId, {
    ViewChannel: true,
    SendMessages: false,
    ReadMessageHistory: true
  }, reason).catch(logLockFailure("owner overwrite"));

  for (const participantId of ticket.participants) {
    await typedChannel.permissionOverwrites?.edit(participantId, {
      ViewChannel: true,
      SendMessages: false,
      ReadMessageHistory: true
    }, reason).catch(logLockFailure(`participant ${participantId} overwrite`));
  }

  await typedChannel.setName?.(`closed-${ticketNumber(ticket.number)}`, reason).catch(logLockFailure("rename"));

  // Move the closed ticket into the archive category (channel-level overwrites are
  // kept, so the owner still sees it read-only).
  if (guild) {
    const archive = await ensureTicketArchiveCategory(guild);
    if (archive) {
      await typedChannel.setParent?.(archive.id, { lockPermissions: false, reason }).catch(logLockFailure("move to archive"));
    }
  }
}

async function collectTicketMessages(ticket: Ticket, guild: Guild, limit = 1000) {
  const channel = await guild.channels.fetch(ticket.channelId).catch(() => null);
  if (channel?.type !== ChannelType.GuildText) return [];

  const textChannel = channel as TextChannel;
  const messages: Message[] = [];
  let before: string | undefined;

  for (;;) {
    const batch = await textChannel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!batch || batch.size === 0) break;
    messages.push(...batch.values());
    before = batch.last()?.id;
    if (batch.size < 100 || messages.length >= limit) break;
  }

  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).slice(-limit);
}

function formatTicketMessagesForAi(messages: Message[]) {
  return messages.map((message) => {
    const content = message.content || "[kein Textinhalt]";
    const attachments = message.attachments.size
      ? ` | Anhänge: ${[...message.attachments.values()].map((attachment) => attachment.name ?? "Datei").join(", ")}`
      : "";
    return `[${message.createdAt.toISOString()}] ${message.author.tag}: ${content}${attachments}`;
  }).join("\n").slice(-12000);
}

async function createTicketTranscript(ticket: Ticket, guild: Guild) {
  const sorted = await collectTicketMessages(ticket, guild, 1000);
  if (!sorted.length) return undefined;
  const category = getTicketCategory(ticket.category);
  const lines = [
    `Ticket ${ticketNumber(ticket.number)} - ${ticket.subject}`,
    `Kategorie: ${category.label}`,
    `Ersteller: ${ticket.ownerId}`,
    `Kanal: ${ticket.channelId}`,
    `Erstellt: ${ticket.createdAt}`,
    "",
    "Nachrichten:",
    ""
  ];

  for (const message of sorted) {
    const timestamp = message.createdAt.toISOString();
    const author = `${message.author.tag} (${message.author.id})`;
    const content = message.content || "[kein Textinhalt]";
    lines.push(`[${timestamp}] ${author}: ${content}`);
    if (message.attachments.size) {
      for (const attachment of message.attachments.values()) {
        lines.push(`  Anhang: ${attachment.name ?? "Datei"} ${attachment.url}`);
      }
    }
  }

  const filePath = join(config.BOT_DATA_DIR, "transcripts", `ticket-${ticketNumber(ticket.number)}.txt`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function createTicketForUser(options: {
  guild: Guild;
  user: User;
  categoryId: string;
  subject: string;
  description?: string;
  reason?: string;
  autoAnalyze?: boolean;
  autoCategory?: boolean;
}) {
  let analysis: TicketAnalysis = {
    categoryId: getTicketCategory(options.categoryId).id,
    priority: "normal",
    priorityReason: "Normale Support-Anfrage.",
    missingInfoQuestions: [],
    shortSummary: options.subject
  };

  if (options.autoAnalyze) {
    try {
      analysis = await analyzeTicketInput({
        subject: options.subject,
        description: options.description,
        fallbackCategoryId: options.categoryId
      });
    } catch (error) {
      await logErrorToDiscord({
        guild: options.guild,
        title: "Ticket AI-Analyse fehlgeschlagen",
        error,
        context: {
          user: options.user.tag,
          userId: options.user.id,
          subject: options.subject
        }
      });
    }
  }

  const ticketCategory = getTicketCategory(options.autoCategory ? analysis.categoryId : options.categoryId);
  const category = await ensureTicketCategory(options.guild);
  const number = await ticketStore.nextNumber(options.guild.id);
  const channelName = `${ticketCategory.channelPrefix}-${ticketNumber(number)}-${slugify(options.user.username)}`;
  const channel = await options.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket ${ticketNumber(number)} (${ticketCategory.label}) von ${options.user.tag}: ${options.subject}`,
    permissionOverwrites: ticketPermissionOverwrites(options.guild, options.user.id),
    reason: options.reason || `Ticket ${ticketNumber(number)} created by ${options.user.tag}`
  });

  const ticket = await ticketStore.create({
    number,
    guildId: options.guild.id,
    channelId: channel.id,
    ownerId: options.user.id,
    category: ticketCategory.id,
    priority: analysis.priority,
    priorityReason: analysis.priorityReason,
    aiSummary: analysis.shortSummary,
    missingInfoQuestions: analysis.missingInfoQuestions,
    subject: options.subject,
    description: options.description
  });

  const teamMentions = ticketTeamRoleIds(options.guild).map((roleId) => `<@&${roleId}>`).join(" ");
  await channel.send({
    content: `<@${options.user.id}> ${teamMentions}`.trim(),
    embeds: [new EmbedBuilder()
      .setTitle(`Ticket ${ticketNumber(ticket.number)}: ${options.subject}`)
      .setDescription(options.description || "Bitte beschreibe dein Anliegen hier im Ticket.")
      .addFields(
        { name: "Kategorie", value: ticketCategory.label, inline: true },
        { name: "Prioritaet", value: priorityLabel(ticket.priority), inline: true },
        { name: "User", value: `<@${options.user.id}>`, inline: true },
        { name: "Status", value: "Offen", inline: true }
      )
      .setColor(priorityColor(ticket.priority))
      .setTimestamp()],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(TICKET_CLOSE_BUTTON_ID)
          .setLabel("Ticket schließen")
          .setEmoji("🔒")
          .setStyle(ButtonStyle.Danger)
      )
    ]
  });

  if (analysis.missingInfoQuestions.length) {
    await channel.send({
      content: `<@${options.user.id}>`,
      embeds: [new EmbedBuilder()
        .setTitle("Kurze Rückfragen")
        .setDescription([
          "Damit das Team schneller helfen kann, fehlen noch ein paar Infos:",
          "",
          ...analysis.missingInfoQuestions.map((question, index) => `${index + 1}. ${question}`)
        ].join("\n"))
        .setColor(0xf1c40f)]
    }).catch(() => undefined);
  }

  await logTicket(options.guild, new EmbedBuilder()
    .setTitle("Ticket erstellt")
    .setDescription(`<@${options.user.id}> hat <#${channel.id}> erstellt.`)
    .addFields(
      { name: "Kategorie", value: ticketCategory.label, inline: true },
      { name: "Prioritaet", value: priorityLabel(ticket.priority), inline: true },
      { name: "Thema", value: options.subject, inline: true },
      { name: "AI-Hinweis", value: analysis.priorityReason || "Keine Angabe" }
    )
    .setColor(priorityColor(ticket.priority))
    .setTimestamp());

  return { ticket, channel };
}

async function closeTicketAndAnnounce(guild: Guild, ticket: Ticket, closerId: string, reason?: string) {
  const transcriptPath = await createTicketTranscript(ticket, guild).catch(() => undefined);
  const closed = await ticketStore.close(ticket.id, closerId, reason, transcriptPath);
  if (!closed) return null;

  await lockTicketChannel(closed, reason || "Ticket geschlossen");

  const channel = await guild.channels.fetch(closed.channelId).catch(() => null);
  if (canSend(channel)) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`Ticket ${ticketNumber(closed.number)} geschlossen`)
        .setDescription(reason || "Kein Grund angegeben.")
        .addFields({ name: "Geschlossen von", value: `<@${closerId}>`, inline: true })
        .setColor(0xe74c3c)
        .setTimestamp()]
    }).catch(() => undefined);
  }

  await logTicketWithTranscript(guild, new EmbedBuilder()
    .setTitle("Ticket geschlossen")
    .setDescription(`<#${closed.channelId}> wurde von <@${closerId}> geschlossen.`)
    .addFields(
      { name: "Grund", value: reason || "Kein Grund angegeben." },
      { name: "Transkript", value: transcriptPath ? "Wurde angehängt und lokal gespeichert." : "Konnte nicht erstellt werden." }
    )
    .setColor(0xe74c3c)
    .setTimestamp(), transcriptPath);

  await createFaqDraftForClosedTicket(guild, closed);
  return closed;
}

async function handleTicketCloseButton(interaction: ButtonInteraction) {
  if (!interaction.guild) return;
  const ticket = await ticketStore.getByChannel(interaction.guild.id, interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ ephemeral: true, content: "Hier gibt es kein offenes Ticket zum Schließen." });
    return;
  }
  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (ticket.ownerId !== interaction.user.id && (!member || !isTicketTeamMember(member))) {
    await interaction.reply({ ephemeral: true, content: "Nur der Ticket-Ersteller oder das Team kann dieses Ticket schließen." });
    return;
  }
  await interaction.reply({ ephemeral: true, content: "Ticket wird geschlossen …" });
  await closeTicketAndAnnounce(interaction.guild, ticket, interaction.user.id);
}

async function handleTicketCreateButton(interaction: ButtonInteraction) {
  if (!interaction.guild || !interaction.channelId) return;

  if (!(await isTicketEntryChannel(interaction.guild, interaction.channelId))) {
    const entryChannel = await findTicketEntryChannel(interaction.guild);
    await interaction.reply({
      ephemeral: true,
      content: entryChannel
        ? `Bitte öffne Tickets nur in <#${entryChannel.id}>.`
        : "Der Ticket-Eingangskanal wurde nicht gefunden."
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(TICKET_CREATE_MODAL_ID)
    .setTitle("Support-Ticket öffnen")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TICKET_MODAL_SUBJECT_ID)
          .setLabel("Worum geht es?")
          .setPlaceholder("z.B. Login funktioniert nicht")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80)
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(TICKET_MODAL_DESCRIPTION_ID)
          .setLabel("Beschreibe dein Anliegen")
          .setPlaceholder("Gerät, App, Fehlermeldung, Jellyfin-Name ...")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
      )
    );

  await interaction.showModal(modal);
}

async function handleTicketCreateModal(interaction: ModalSubmitInteraction) {
  if (!interaction.guild || !interaction.channelId) return;

  if (!(await isTicketEntryChannel(interaction.guild, interaction.channelId))) {
    const entryChannel = await findTicketEntryChannel(interaction.guild);
    await interaction.reply({
      ephemeral: true,
      content: entryChannel
        ? `Bitte öffne Tickets nur in <#${entryChannel.id}>.`
        : "Der Ticket-Eingangskanal wurde nicht gefunden."
    });
    return;
  }

  const subject = (interaction.fields.getTextInputValue(TICKET_MODAL_SUBJECT_ID).trim() || "Support-Anfrage").slice(0, 80);
  const rawDescription = interaction.fields.getTextInputValue(TICKET_MODAL_DESCRIPTION_ID).trim();
  const category = inferTicketCategory(`${subject}\n${rawDescription}`);
  await interaction.deferReply({ ephemeral: true });

  const outcome = await createTicketWithLimit(interaction.guild, interaction.user.id, {
    guild: interaction.guild,
    user: interaction.user,
    categoryId: category.id,
    subject,
    description: rawDescription || undefined,
    reason: `Ticket created by button panel from ${interaction.user.tag}`,
    autoAnalyze: true,
    autoCategory: true
  });
  if (outcome.limited) {
    await interaction.editReply(`Du hast bereits ein offenes Ticket: <#${outcome.existing.channelId}>`);
    return;
  }

  await interaction.editReply(`Ticket erstellt: <#${outcome.result.channel.id}>`);
}

async function handleLibraryScanButton(interaction: ButtonInteraction) {
  if (!interaction.guild) return;

  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann einen Bibliotheksscan starten." });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await refreshJellyfinLibrary();
  await interaction.editReply("Jellyfin-Bibliotheksscan wurde gestartet.");
  await logToDiscord(interaction.guild, new EmbedBuilder()
    .setTitle("Jellyfin-Bibliotheksscan gestartet")
    .setDescription(`<@${interaction.user.id}> hat den Scan per Bot-Button gestartet.`)
    .setColor(0x3498db)
    .setTimestamp());
}

function suggestionComponents(id: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AI_SUGGEST_SEND_PREFIX}${id}`)
        .setLabel("Antwort senden")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${AI_SUGGEST_DISCARD_PREFIX}${id}`)
        .setLabel("Verwerfen")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function faqDraftComponents(id: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${AI_FAQ_APPROVE_PREFIX}${id}`)
        .setLabel("FAQ übernehmen")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${AI_FAQ_DISCARD_PREFIX}${id}`)
        .setLabel("Verwerfen")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function handleSendSuggestionButton(interaction: ButtonInteraction, id: string) {
  if (!interaction.guild) return;
  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann Antwortvorschläge senden." });
    return;
  }

  const suggestion = pendingReplySuggestions.get(id);
  if (!suggestion) {
    await interaction.reply({ ephemeral: true, content: "Dieser Vorschlag ist nicht mehr verfügbar." });
    return;
  }

  const channel = await interaction.guild.channels.fetch(suggestion.channelId).catch(() => null);
  if (!canSend(channel)) {
    await interaction.reply({ ephemeral: true, content: "Ticket-Kanal nicht gefunden oder nicht beschreibbar." });
    return;
  }

  await channel.send({ content: suggestion.text });
  pendingReplySuggestions.delete(id);
  await interaction.update({
    content: "Antwortvorschlag wurde gesendet.",
    embeds: [],
    components: []
  });
}

async function handleDiscardSuggestionButton(interaction: ButtonInteraction, id: string) {
  pendingReplySuggestions.delete(id);
  await interaction.update({
    content: "Antwortvorschlag wurde verworfen.",
    embeds: [],
    components: []
  });
}

async function handleApproveFaqButton(interaction: ButtonInteraction, id: string) {
  if (!interaction.guild) return;
  const member = interaction.member instanceof GuildMember
    ? interaction.member
    : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann FAQ-Entwuerfe übernehmen." });
    return;
  }

  const pending = pendingFaqDrafts.get(id);
  if (!pending || !pending.draft.title || !pending.draft.answer) {
    await interaction.reply({ ephemeral: true, content: "Dieser FAQ-Entwurf ist nicht mehr verfügbar." });
    return;
  }

  const stored = await faqStore.add({
    title: pending.draft.title,
    keywords: pending.draft.keywords,
    answer: pending.draft.answer,
    approvedBy: interaction.user.id,
    sourceTicketId: pending.ticketId
  });
  pendingFaqDrafts.delete(id);
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setTitle("FAQ übernommen")
      .setDescription(`Der Eintrag **${stored.title}** ist jetzt in der dynamischen FAQ verfügbar.`)
      .setColor(0x2ecc71)
      .setTimestamp()],
    components: []
  });
}

async function handleDiscardFaqButton(interaction: ButtonInteraction, id: string) {
  pendingFaqDrafts.delete(id);
  await interaction.update({
    embeds: [new EmbedBuilder()
      .setTitle("FAQ-Entwurf verworfen")
      .setColor(0x95a5a6)
      .setTimestamp()],
    components: []
  });
}

async function ticketAiMessages(ticket: Ticket, guild: Guild) {
  const messages = await collectTicketMessages(ticket, guild, 80);
  return formatTicketMessagesForAi(messages);
}

async function handleTicketSummaryCommand(interaction: ChatInputCommandInteraction, ticket: Ticket) {
  if (!interaction.guild) return;
  const member = await getInteractionMember(interaction);
  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann Ticket-Zusammenfassungen erstellen." });
    return;
  }
  if (!isOpenAiAssistantReady()) {
    await interaction.reply({ ephemeral: true, content: "Der AI-Assistent ist noch nicht aktiviert." });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const category = getTicketCategory(ticket.category);
  const summary = await generateTicketSummary({
    subject: ticket.subject,
    categoryLabel: category.label,
    priority: ticket.priority,
    messages: await ticketAiMessages(ticket, interaction.guild)
  });
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle(`Zusammenfassung Ticket ${ticketNumber(ticket.number)}`)
      .setDescription(summary)
      .addFields(
        { name: "Kategorie", value: category.label, inline: true },
        { name: "Prioritaet", value: priorityLabel(ticket.priority), inline: true }
      )
      .setColor(priorityColor(ticket.priority))
      .setTimestamp()]
  });
}

async function handleTicketSuggestCommand(interaction: ChatInputCommandInteraction, ticket: Ticket) {
  if (!interaction.guild) return;
  const member = await getInteractionMember(interaction);
  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann Antwortvorschläge erstellen." });
    return;
  }
  if (!isOpenAiAssistantReady()) {
    await interaction.reply({ ephemeral: true, content: "Der AI-Assistent ist noch nicht aktiviert." });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const category = getTicketCategory(ticket.category);
  const suggestion = await generateReplySuggestion({
    subject: ticket.subject,
    categoryLabel: category.label,
    priority: ticket.priority,
    messages: await ticketAiMessages(ticket, interaction.guild)
  });
  const id = randomUUID().slice(0, 10);
  pendingReplySuggestions.set(id, {
    channelId: ticket.channelId,
    ticketId: ticket.id,
    text: suggestion,
    createdBy: interaction.user.id,
    createdAt: Date.now()
  });

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle(`Antwortvorschlag Ticket ${ticketNumber(ticket.number)}`)
      .setDescription(suggestion)
      .setColor(0x3498db)
      .setFooter({ text: "Wird erst gesendet, wenn du auf Antwort senden klickst." })
      .setTimestamp()],
    components: suggestionComponents(id)
  });
}

async function createFaqDraftForClosedTicket(guild: Guild, ticket: Ticket) {
  if (!isOpenAiAssistantReady()) return;

  try {
    const category = getTicketCategory(ticket.category);
    const draft = await generateFaqDraft({
      subject: ticket.subject,
      categoryLabel: category.label,
      messages: await ticketAiMessages(ticket, guild)
    });
    if (!draft.title || !draft.answer) return;

    const id = randomUUID().slice(0, 10);
    pendingFaqDrafts.set(id, { draft, ticketId: ticket.id, createdAt: Date.now() });
    await sendTicketLogPayload(guild, {
      embeds: [new EmbedBuilder()
        .setTitle("FAQ-Entwurf aus geschlossenem Ticket")
        .setDescription(draft.answer)
        .addFields(
          { name: "Titel", value: draft.title },
          { name: "Keywords", value: draft.keywords.length ? draft.keywords.join(", ") : "Keine" },
          { name: "Quelle", value: `<#${ticket.channelId}>`, inline: true }
        )
        .setColor(0x9b59b6)
        .setFooter({ text: "Erst nach Freigabe wird dieser Eintrag gespeichert." })
        .setTimestamp()],
      components: faqDraftComponents(id)
    });
  } catch (error) {
    await logErrorToDiscord({
      guild,
      title: "FAQ-Entwurf fehlgeschlagen",
      error,
      context: {
        ticket: ticket.id,
        subject: ticket.subject
      }
    });
  }
}

async function handleTicketCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;

  const subcommand = interaction.options.getSubcommand();
  const member = await getInteractionMember(interaction);

  if (subcommand === "create") {
    if (!(await isTicketEntryChannel(interaction.guild, interaction.channelId))) {
      const entryChannel = await findTicketEntryChannel(interaction.guild);
      await interaction.reply({
        ephemeral: true,
        content: entryChannel
          ? `Bitte öffne Tickets nur in <#${entryChannel.id}>.`
          : "Der Ticket-Eingangskanal wurde nicht gefunden."
      });
      return;
    }

    const ticketCategory = getTicketCategory(interaction.options.getString("kategorie") ?? "sonstiges");
    const subject = interaction.options.getString("thema", true).trim();
    const description = interaction.options.getString("beschreibung")?.trim();
    await interaction.deferReply({ ephemeral: true });

    const outcome = await createTicketWithLimit(interaction.guild, interaction.user.id, {
      guild: interaction.guild,
      user: interaction.user,
      categoryId: ticketCategory.id,
      subject,
      description,
      reason: `Ticket created by slash command from ${interaction.user.tag}`,
      autoAnalyze: true,
      autoCategory: false
    });
    if (outcome.limited) {
      await interaction.editReply(`Du hast bereits ein offenes Ticket: <#${outcome.existing.channelId}>`);
      return;
    }

    await interaction.editReply(`Ticket erstellt: <#${outcome.result.channel.id}>`);
    return;
  }

  if (subcommand === "list") {
    if (!member || !isTicketTeamMember(member)) {
      await interaction.reply({ ephemeral: true, content: "Nur das Team kann offene Tickets auflisten." });
      return;
    }

    const tickets = await ticketStore.listOpen(interaction.guild.id);
    const lines = tickets.slice(0, 20).map((ticket) =>
      `#${ticketNumber(ticket.number)} <#${ticket.channelId}> von <@${ticket.ownerId}> - ${ticket.subject}`
    );
    await interaction.reply({
      ephemeral: true,
      content: lines.length ? lines.join("\n") : "Es gibt keine offenen Tickets."
    });
    return;
  }

  const ticket = await ticketStore.getByChannel(interaction.guild.id, interaction.channelId);
  if (!ticket || ticket.status !== "open") {
    await interaction.reply({ ephemeral: true, content: "Dieser Befehl funktioniert nur in einem offenen Ticket-Kanal." });
    return;
  }

  if (subcommand === "summary") {
    await handleTicketSummaryCommand(interaction, ticket);
    return;
  }

  if (subcommand === "suggest") {
    await handleTicketSuggestCommand(interaction, ticket);
    return;
  }

  if (subcommand === "close") {
    if (ticket.ownerId !== interaction.user.id && (!member || !isTicketTeamMember(member))) {
      await interaction.reply({ ephemeral: true, content: "Nur der Ticket-Ersteller oder das Team kann dieses Ticket schließen." });
      return;
    }

    const reason = interaction.options.getString("grund")?.trim();
    await interaction.deferReply();
    const closed = await closeTicketAndAnnounce(interaction.guild, ticket, interaction.user.id, reason);
    await interaction.editReply(closed ? "Ticket geschlossen." : "Ticket konnte nicht gefunden werden.");
    return;
  }

  if (!member || !isTicketTeamMember(member)) {
    await interaction.reply({ ephemeral: true, content: "Nur das Team kann Teilnehmer in Tickets verwalten." });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const channel = await interaction.guild.channels.fetch(ticket.channelId).catch(() => null);
  const editableChannel = channel as unknown as {
    permissionOverwrites?: {
      edit: (id: string, options: Record<string, boolean>, reason?: string) => Promise<unknown>;
      delete: (id: string, reason?: string) => Promise<unknown>;
    };
  };

  if (subcommand === "add") {
    await ticketStore.addParticipant(ticket.id, user.id);
    await editableChannel.permissionOverwrites?.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      UseApplicationCommands: true
    }, "Ticket participant added");
    await interaction.reply({ content: `<@${user.id}> wurde zum Ticket hinzugefügt.` });
    return;
  }

  if (subcommand === "remove") {
    if (user.id === ticket.ownerId) {
      await interaction.reply({ ephemeral: true, content: "Der Ticket-Ersteller kann nicht entfernt werden." });
      return;
    }
    await ticketStore.removeParticipant(ticket.id, user.id);
    await editableChannel.permissionOverwrites?.delete(user.id, "Ticket participant removed");
    await interaction.reply({ content: `<@${user.id}> wurde aus dem Ticket entfernt.` });
  }
}

async function handleTicketEntryMessage(message: Message) {
  if (!config.ENABLE_SUPPORT_MESSAGE_TICKETS || !message.guild || message.author.bot) return false;
  if (!(await isTicketEntryChannel(message.guild, message.channelId))) return false;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (member && isTicketTeamMember(member)) return false;

  const rawContent = message.content.trim();
  const attachmentLines = message.attachments.size
    ? [...message.attachments.values()].map((attachment) => `Anhang: ${attachment.name ?? "Datei"} ${attachment.url}`)
    : [];
  const descriptionParts = [
    rawContent || "Diese Anfrage wurde automatisch aus einer Nachricht im Support-Eingang erstellt.",
    ...attachmentLines
  ];
  const description = descriptionParts.join("\n").slice(0, 1200);
  const subject = (rawContent.split(/\r?\n/)[0]?.trim() || "Support-Anfrage").slice(0, 80);
  const category = inferTicketCategory(rawContent);

  const outcome = await createTicketWithLimit(message.guild, message.author.id, {
    guild: message.guild,
    user: message.author,
    categoryId: category.id,
    subject,
    description,
    reason: `Ticket created from support entry message by ${message.author.tag}`,
    autoAnalyze: true,
    autoCategory: true
  });
  if (outcome.limited) {
    await message.delete().catch(() => undefined);
    await message.author.send(`Du hast bereits ein offenes Ticket: <#${outcome.existing.channelId}>`).catch(() => undefined);
    return true;
  }

  await message.delete().catch(() => undefined);
  await message.author.send(`Dein Support-Ticket wurde erstellt: <#${outcome.result.channel.id}>`).catch(() => undefined);
  return true;
}

function warningSourceLabel(source: WarningEntry["source"]) {
  return source === "auto" ? "Auto" : "Manuell";
}

function formatWarningLine(warning: WarningEntry) {
  const status = warning.active ? "aktiv" : "entfernt";
  const timestamp = `<t:${Math.floor(new Date(warning.createdAt).getTime() / 1000)}:d>`;
  const reason = warning.reason.length > 80 ? `${warning.reason.slice(0, 77)}...` : warning.reason;
  return `\`${warning.id}\` ${status} | ${timestamp} | ${warningSourceLabel(warning.source)} | ${reason}`;
}

async function handleSupportStatusCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;

  const subcommand = interaction.options.getSubcommand();
  const member = await getInteractionMember(interaction);

  if (subcommand === "set") {
    if (!member || !isTicketTeamMember(member)) {
      await interaction.reply({ ephemeral: true, content: "Nur das Team kann den Support-Status setzen." });
      return;
    }

    const status = interaction.options.getString("status", true) as SupportStatus;
    const fallbackMessage = status === "online"
      ? "Support ist aktuell erreichbar."
      : status === "busy"
        ? "Support ist gerade beschäftigt, antwortet aber später."
        : "Support ist aktuell offline.";
    const message = interaction.options.getString("nachricht")?.trim() || fallbackMessage;
    const state = await supportStore.set(status, message, interaction.user.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle("Support-Status aktualisiert")
        .setDescription(state.message)
        .addFields(
          { name: "Status", value: supportStatusLabel(state.status), inline: true },
          { name: "Gesetzt von", value: `<@${interaction.user.id}>`, inline: true }
        )
        .setColor(supportStatusColor(state.status))
        .setTimestamp()]
    });
    return;
  }

  const state = await supportStore.get();
  const openTickets = await ticketStore.listOpen(interaction.guild.id);
  await interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setTitle("Support-Status")
      .setDescription(state.message)
      .addFields(
        { name: "Status", value: supportStatusLabel(state.status), inline: true },
        { name: "Offene Tickets", value: String(openTickets.length), inline: true },
        { name: "Aktualisiert", value: state.updatedAt ? `<t:${Math.floor(new Date(state.updatedAt).getTime() / 1000)}:R>` : "Noch nie", inline: true }
      )
      .setColor(supportStatusColor(state.status))
      .setTimestamp()]
  });
}

async function registerCommands() {
  if (!config.AUTO_REGISTER_COMMANDS || !client.user) return;
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

  if (config.DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.DISCORD_GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} guild commands.`);
    return;
  }

  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log(`Registered ${commands.length} global commands.`);
}

// Resolve a managed role by remembered ID first, then by name (caching the ID), and
// only create it if it really does not exist - so renaming it never spawns a duplicate.
async function ensureSetupRole(guild: Guild, key: string, name: string) {
  const storedId = await setupStore.getId(guild.id, key);
  if (storedId) {
    const byId = guild.roles.cache.get(storedId) ?? await guild.roles.fetch(storedId).catch(() => null);
    if (byId) return { created: false };
  }
  const byName = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (byName) {
    await setupStore.setId(guild.id, key, byName.id);
    return { created: false };
  }
  const role = await guild.roles.create({ name, reason: "Jellyfin Discord bot setup" });
  await setupStore.setId(guild.id, key, role.id);
  return { created: true };
}

async function ensureSetupTextChannel(guild: Guild, key: string, name: string, parentId: string) {
  const storedId = await setupStore.getId(guild.id, key);
  if (storedId) {
    const byId = await guild.channels.fetch(storedId).catch(() => null);
    if (byId) return { created: false };
  }
  const byName = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildText && channel.name.toLowerCase() === name.toLowerCase()
  );
  if (byName) {
    await setupStore.setId(guild.id, key, byName.id);
    return { created: false };
  }
  const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId, reason: "Jellyfin Discord bot setup" });
  await setupStore.setId(guild.id, key, channel.id);
  return { created: true };
}

async function setupGuild(guild: Guild) {
  const created: string[] = [];

  if ((await ensureSetupRole(guild, "role:member", "Jellyfin Mitglied")).created) created.push("Rolle: Jellyfin Mitglied");
  if ((await ensureSetupRole(guild, "role:support", "Support")).created) created.push("Rolle: Support");

  const categoryStoredId = await setupStore.getId(guild.id, "category:jellyfin");
  let category = categoryStoredId ? await guild.channels.fetch(categoryStoredId).catch(() => null) : null;
  if (category?.type !== ChannelType.GuildCategory) {
    const byName = guild.channels.cache.find((channel) =>
      channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === "jellyfin"
    );
    if (byName?.type === ChannelType.GuildCategory) {
      category = byName;
    } else {
      category = await guild.channels.create({ name: "Jellyfin", type: ChannelType.GuildCategory, reason: "Jellyfin Discord bot setup" });
      created.push("Kategorie: Jellyfin");
    }
  }
  await setupStore.setId(guild.id, "category:jellyfin", category.id);

  for (const name of ["welcome", "support", "status", "payments", "mod-log"]) {
    if ((await ensureSetupTextChannel(guild, `channel:${name}`, name, category.id)).created) {
      created.push(`Kanal: #${name}`);
    }
  }

  return created;
}

async function handleServerAufbauCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  await interaction.deferReply({ ephemeral: true });
  await interaction.guild.setName("Byteflix").catch(() => undefined);
  const result = await buildByteflixServer(interaction.guild, setupStore);
  await ensureTicketEntryInstructions(interaction.guild).catch(() => undefined);
  const header = result.summary.length
    ? `Byteflix-Aufbau fertig - ${result.summary.length} neue Elemente angelegt:`
    : "Byteflix-Aufbau fertig - alles war bereits vorhanden (Rechte/Topics wurden aktualisiert).";
  const body = result.summary.slice(0, 40).join("\n");
  const extra = result.summary.length > 40 ? `\n… und ${result.summary.length - 40} weitere.` : "";
  const warn = result.failures.length
    ? `\n\n⚠️ ${result.failures.length} Problem(e):\n${result.failures.slice(0, 8).join("\n")}`
    : "";
  await interaction.editReply(`${header}\n${body}${extra}${warn}`.slice(0, 1900));
}

const STATS_CATEGORY_NAME = "📊 Jellyfin Stats";

type RenamableChannel = { name: string; setName: (name: string, reason?: string) => Promise<unknown> };
type StatChannelPlanItem = { key: string; kind: StatsChannelKind; libraryId?: string; name: string };

function formatStatCount(value: number) {
  return value.toLocaleString("de-DE");
}

function libraryStatEmoji(collectionType?: string) {
  switch (collectionType) {
    case "movies":
      return "🎬";
    case "tvshows":
      return "📺";
    case "music":
      return "🎵";
    case "books":
      return "📚";
    default:
      return "📁";
  }
}

function statChannelName(label: string, count: number, emoji: string) {
  // Discord caps channel names at 100 characters.
  return `${emoji} ${label} — ${formatStatCount(count)}`.slice(0, 100);
}

function buildStatChannelPlan(stats: JellyfinLibraryStats): StatChannelPlanItem[] {
  const plan: StatChannelPlanItem[] = [];
  // Movie/series totals are intentionally omitted: with a single movies/tvshows
  // library they collide 1:1 with the per-library channels below (duplicate names).
  // Episodes have no per-library channel, so the "Folgen" total is kept.
  if (typeof stats.totals.episodes === "number") {
    plan.push({ key: "total-episodes", kind: "total-episodes", name: statChannelName("Folgen", stats.totals.episodes, "🎞️") });
  }
  for (const library of stats.libraries) {
    plan.push({
      key: `library:${library.id}`,
      kind: "library",
      libraryId: library.id,
      name: statChannelName(library.name, library.count, libraryStatEmoji(library.collectionType))
    });
  }
  return plan;
}

function statEntryKey(entry: StatsChannelEntry) {
  return entry.libraryId ? `library:${entry.libraryId}` : entry.kind;
}

async function renameStatChannelIfChanged(channel: RenamableChannel, desired: string) {
  if (channel.name === desired) return;
  await channel.setName(desired, "Jellyfin stats update").catch((error) => {
    console.error("[stats] rename failed", error);
  });
}

function lockedStatOverwrites(guild: Guild) {
  return [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect] }];
}

async function updateStatsForGuild(guild: Guild) {
  const existing = await statsStore.getGuild(guild.id);
  if (!existing?.channels.length) return;
  const stats = await getJellyfinLibraryStats();
  if (!stats.configured) return;
  const planByKey = new Map(buildStatChannelPlan(stats).map((item) => [item.key, item]));
  for (const entry of existing.channels) {
    const item = planByKey.get(statEntryKey(entry));
    if (!item) continue;
    const channel = await guild.channels.fetch(entry.channelId).catch(() => null);
    if (!channel) continue;
    await renameStatChannelIfChanged(channel as unknown as RenamableChannel, item.name);
  }
}

async function updateAllStats() {
  for (const guild of client.guilds.cache.values()) {
    await updateStatsForGuild(guild).catch((error) => console.error("[stats] update failed", error));
  }
}

async function handleStatsSetup(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  await interaction.deferReply({ ephemeral: true });

  const stats = await getJellyfinLibraryStats();
  if (!stats.configured) {
    await interaction.editReply("Jellyfin ist nicht konfiguriert (JELLYFIN_BASE_URL / JELLYFIN_API_KEY fehlen).");
    return;
  }
  const plan = buildStatChannelPlan(stats);
  if (!plan.length) {
    await interaction.editReply("Es kamen keine Bibliotheken oder Zahlen von Jellyfin zurück.");
    return;
  }

  const existing = await statsStore.getGuild(interaction.guild.id);
  const existingCategory = existing?.categoryId
    ? await interaction.guild.channels.fetch(existing.categoryId).catch(() => null)
    : null;
  const category = existingCategory?.type === ChannelType.GuildCategory
    ? existingCategory
    : await interaction.guild.channels.create({
        name: STATS_CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: lockedStatOverwrites(interaction.guild),
        reason: "Jellyfin stats setup"
      });

  const existingByKey = new Map((existing?.channels ?? []).map((entry) => [statEntryKey(entry), entry]));
  const channels: StatsChannelEntry[] = [];
  for (const item of plan) {
    const prior = existingByKey.get(item.key);
    const priorChannel = prior
      ? await interaction.guild.channels.fetch(prior.channelId).catch(() => null)
      : null;
    if (priorChannel) {
      await renameStatChannelIfChanged(priorChannel as unknown as RenamableChannel, item.name);
      channels.push({ channelId: priorChannel.id, kind: item.kind, libraryId: item.libraryId });
    } else {
      const created = await interaction.guild.channels.create({
        name: item.name,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: lockedStatOverwrites(interaction.guild),
        reason: "Jellyfin stats setup"
      });
      channels.push({ channelId: created.id, kind: item.kind, libraryId: item.libraryId });
    }
  }

  // Remove channels from an earlier setup that are no longer in the plan
  // (e.g. the old total-movies/total-series channels that caused duplicates).
  const planKeys = new Set(plan.map((item) => item.key));
  for (const entry of existing?.channels ?? []) {
    if (planKeys.has(statEntryKey(entry))) continue;
    const stale = await interaction.guild.channels.fetch(entry.channelId).catch(() => null);
    await stale?.delete("Jellyfin stats cleanup").catch(() => undefined);
  }

  await statsStore.setGuild(interaction.guild.id, { categoryId: category.id, channels });
  await interaction.editReply(
    `Statistik-Kanäle eingerichtet: ${channels.length} gesperrte Sprachkanäle unter "${STATS_CATEGORY_NAME}". Aktualisierung alle ${config.STATS_REFRESH_MINUTES} Min (Discord limitiert Umbenennungen, daher nicht in Echtzeit).`
  );
}

async function handleStatsRefresh(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  await interaction.deferReply({ ephemeral: true });
  const existing = await statsStore.getGuild(interaction.guild.id);
  if (!existing?.channels.length) {
    await interaction.editReply("Es sind keine Statistik-Kanäle eingerichtet. Nutze zuerst /stats setup.");
    return;
  }
  await updateStatsForGuild(interaction.guild);
  await interaction.editReply("Statistik-Kanäle aktualisiert (Umbenennungen koennen wegen Discord-Limits leicht verzoegert sein).");
}

async function handleStatsRemove(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  await interaction.deferReply({ ephemeral: true });
  const existing = await statsStore.getGuild(interaction.guild.id);
  if (!existing) {
    await interaction.editReply("Es sind keine Statistik-Kanäle eingerichtet.");
    return;
  }
  for (const entry of existing.channels) {
    const channel = await interaction.guild.channels.fetch(entry.channelId).catch(() => null);
    await channel?.delete("Jellyfin stats removed").catch(() => undefined);
  }
  if (existing.categoryId) {
    const category = await interaction.guild.channels.fetch(existing.categoryId).catch(() => null);
    await category?.delete("Jellyfin stats removed").catch(() => undefined);
  }
  await statsStore.clearGuild(interaction.guild.id);
  await interaction.editReply("Statistik-Kanäle entfernt.");
}

const TRIAL_ROLE_NAME = "Trial";
const TRIAL_LOG_CHANNEL_NAME = "trial-log";

function randomFromAlphabet(length: number, alphabet: string) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generateTrialUsername() {
  // 8 random characters: lowercase letters + digits (ambiguous chars 0/o/1/l removed).
  return randomFromAlphabet(8, "abcdefghijkmnpqrstuvwxyz23456789");
}

function generateTrialPassword() {
  return randomFromAlphabet(10, "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789");
}

async function resolveTrialRole(guild: Guild) {
  if (config.DISCORD_TRIAL_ROLE_ID) {
    const byId = guild.roles.cache.get(config.DISCORD_TRIAL_ROLE_ID)
      ?? await guild.roles.fetch(config.DISCORD_TRIAL_ROLE_ID).catch(() => null);
    if (byId) return byId;
  }
  const byName = guild.roles.cache.find((role) => role.name.toLowerCase() === TRIAL_ROLE_NAME.toLowerCase());
  if (byName) return byName;
  return guild.roles.create({ name: TRIAL_ROLE_NAME, reason: "Trial-Rolle (Setup)" }).catch(() => null);
}

async function resolveTrialLogChannel(guild: Guild) {
  if (config.DISCORD_TRIAL_LOG_CHANNEL_ID) {
    const configured = await guild.channels.fetch(config.DISCORD_TRIAL_LOG_CHANNEL_ID).catch(() => null);
    if (configured) return configured;
  }
  return guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === TRIAL_LOG_CHANNEL_NAME
  ) ?? null;
}

async function logTrial(guild: Guild, embed: EmbedBuilder) {
  const channel = await resolveTrialLogChannel(guild);
  if (canSend(channel)) await channel.send({ embeds: [embed] }).catch(() => undefined);
}

async function handleTrialCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  if (!isJfaGoConfigured()) {
    await interaction.reply({ ephemeral: true, content: "Der Testzugang ist gerade nicht verfügbar (jfa-go ist nicht konfiguriert)." });
    return;
  }

  const existing = await trialStore.get(interaction.guild.id, interaction.user.id);
  if (existing) {
    await interaction.reply({ ephemeral: true, content: "Du hast bereits einen Testzugang erhalten." });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const username = generateTrialUsername();
  const password = generateTrialPassword();
  const label = `discord-trial-${interaction.user.id}-${Date.now()}`;

  try {
    await createTrialAccount({ username, password, trialHours: config.TRIAL_HOURS, label });
  } catch (error) {
    await logErrorToDiscord({
      guild: interaction.guild,
      title: "Trial-Account konnte nicht erstellt werden",
      error,
      context: { user: interaction.user.tag, userId: interaction.user.id, username }
    });
    await interaction.editReply("Der Testzugang konnte nicht erstellt werden. Das Team wurde informiert.");
    return;
  }

  const expiresAt = Date.now() + config.TRIAL_HOURS * 60 * 60_000;
  const loginBase = config.JELLYFIN_PUBLIC_URL || config.JELLYFIN_BASE_URL;
  const loginUrl = loginBase ? loginBase.replace(/\/+$/, "") : "(Jellyfin-URL)";
  const expiryTag = `<t:${Math.floor(expiresAt / 1000)}:R>`;

  const dm = [
    "Dein Jellyfin-Testzugang ist bereit:",
    `Login: ${loginUrl}`,
    `Benutzername: \`${username}\``,
    `Passwort: \`${password}\``,
    `Der Zugang laeuft ${expiryTag} automatisch ab.`,
    "Bitte ändere dein Passwort nach dem ersten Login."
  ].join("\n");

  let dmDelivered = true;
  try {
    await interaction.user.send(dm);
  } catch {
    dmDelivered = false;
  }

  let roleId: string | undefined;
  const member = await getInteractionMember(interaction);
  const role = await resolveTrialRole(interaction.guild);
  if (member && role) {
    roleId = role.id;
    await member.roles.add(role, "Trial gestartet").catch(() => undefined);
  }

  await trialStore.set(interaction.guild.id, {
    userId: interaction.user.id,
    jellyfinUsername: username,
    createdAt: new Date().toISOString(),
    expiresAt,
    roleId,
    roleRemoved: false
  });

  await logTrial(interaction.guild, new EmbedBuilder()
    .setTitle("Neuer Trial-Account")
    .setDescription(`<@${interaction.user.id}> hat einen Testzugang erstellt.`)
    .addFields(
      { name: "Jellyfin-Benutzer", value: username, inline: true },
      { name: "Laeuft ab", value: expiryTag, inline: true },
      { name: "DM zugestellt", value: dmDelivered ? "ja" : "nein", inline: true }
    )
    .setColor(0x9b59b6)
    .setTimestamp());

  await interaction.editReply(dmDelivered
    ? "Dein Testzugang wurde erstellt - die Zugangsdaten findest du in deinen DMs."
    : `Dein Testzugang wurde erstellt, aber ich konnte dir keine DM schicken. Hier deine Daten:\nBenutzername: \`${username}\`\nPasswort: \`${password}\`\nLogin: ${loginUrl}`);
}

async function expireTrials() {
  const now = Date.now();
  for (const { guildId, entry } of await trialStore.activeEntries()) {
    if (entry.expiresAt > now) continue;
    const guild = client.guilds.cache.get(guildId);
    if (guild && entry.roleId) {
      const roleId = entry.roleId;
      const member = await guild.members.fetch(entry.userId).catch(() => null);
      if (member) await member.roles.remove(roleId, "Trial abgelaufen").catch(() => undefined);
    }
    await trialStore.set(guildId, { ...entry, roleRemoved: true });
  }
}

const ABO_ROLE_NAME = "Abo";
const PREMIUM_ROLE_NAME = "Premium Abo";
const MEMBER_ROLE_NAME = "Mitglied";
// Trials run TRIAL_HOURS (default 26). An account whose live jfa-go expiry is well
// beyond that has been upgraded (paid) and must not be treated as a trial anymore.
const EXTENDED_THRESHOLD_MS = 30 * 60 * 60_000;

async function resolveManagedRole(guild: Guild, configuredId: string, name: string) {
  if (configuredId) {
    const byId = guild.roles.cache.get(configuredId) ?? await guild.roles.fetch(configuredId).catch(() => null);
    if (byId) return byId;
  }
  const byName = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  return guild.roles.create({ name, reason: "Account-Rollen (Setup)" }).catch(() => null);
}

async function ensureAccountRoles(guild: Guild) {
  await resolveManagedRole(guild, config.DISCORD_TRIAL_ROLE_ID, TRIAL_ROLE_NAME);
  await resolveManagedRole(guild, config.DISCORD_ABO_ROLE_ID, ABO_ROLE_NAME);
  await resolveManagedRole(guild, config.DISCORD_PREMIUM_ROLE_ID, PREMIUM_ROLE_NAME);
}

function memberHasSubscription(member: GuildMember) {
  const names = [ABO_ROLE_NAME.toLowerCase(), PREMIUM_ROLE_NAME.toLowerCase()];
  const ids = [config.DISCORD_ABO_ROLE_ID, config.DISCORD_PREMIUM_ROLE_ID].filter(Boolean);
  return member.roles.cache.some((role) => ids.includes(role.id) || names.includes(role.name.toLowerCase()));
}

// Like resolveManagedRole, but never creates a role - used when we only want to
// remove an existing role and must not accidentally create it as a side effect.
async function findManagedRole(guild: Guild, configuredId: string, name: string) {
  if (configuredId) {
    const byId = guild.roles.cache.get(configuredId) ?? await guild.roles.fetch(configuredId).catch(() => null);
    if (byId) return byId;
  }
  return guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase()) ?? null;
}

// Upgrade a paid/topped-up account: grant Mitglied (kept permanently once paid)
// and Abo, and drop the Trial role. Idempotent - safe to run every sync.
async function applyUpgradeRoles(guild: Guild, member: GuildMember, trialRoleId?: string) {
  const memberRole = await resolveManagedRole(guild, config.DISCORD_MEMBER_ROLE_ID, MEMBER_ROLE_NAME);
  if (memberRole && !member.roles.cache.has(memberRole.id)) {
    await member.roles.add(memberRole, "Account hochgestuft (bezahlt)").catch(() => undefined);
  }
  const aboRole = await resolveManagedRole(guild, config.DISCORD_ABO_ROLE_ID, ABO_ROLE_NAME);
  if (aboRole && !member.roles.cache.has(aboRole.id)) {
    await member.roles.add(aboRole, "Abo aktiv").catch(() => undefined);
  }
  const trialRole = await findManagedRole(guild, config.DISCORD_TRIAL_ROLE_ID, TRIAL_ROLE_NAME);
  for (const roleId of [trialRoleId, trialRole?.id]) {
    if (roleId && member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, "Account hochgestuft").catch(() => undefined);
    }
  }
}

// Subscription ended: remove Abo + Premium, but keep Mitglied (already paid once).
async function removeSubscriptionRoles(guild: Guild, member: GuildMember) {
  const subscriptionRoles: Array<readonly [string, string]> = [
    [config.DISCORD_ABO_ROLE_ID, ABO_ROLE_NAME],
    [config.DISCORD_PREMIUM_ROLE_ID, PREMIUM_ROLE_NAME]
  ];
  for (const [configuredId, name] of subscriptionRoles) {
    const role = await findManagedRole(guild, configuredId, name);
    if (role && member.roles.cache.has(role.id)) {
      await member.roles.remove(role, "Abo abgelaufen").catch(() => undefined);
    }
  }
}

function accountTypeLabel(type?: string) {
  return type === "extended" ? "Abo/Verlängert" : "Trial";
}

async function syncAccounts() {
  if (!isJfaGoConfigured()) return;
  const entries = await trialStore.allEntries();
  if (!entries.length) return;

  let users;
  try {
    users = await listJfaGoUsers();
  } catch (error) {
    console.error("[accounts] jfa-go Benutzerliste fehlgeschlagen", error);
    return; // safety: never treat accounts as deleted when the list can't be fetched
  }
  if (!users.length) {
    console.error("[accounts] jfa-go lieferte 0 Benutzer trotz vorhandener Links - Cleanup übersprungen");
    return;
  }

  const byName = new Map(users.map((user) => [user.name.toLowerCase(), user]));
  const now = Date.now();

  for (const { guildId, entry } of entries) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const jfaUser = byName.get(entry.jellyfinUsername.toLowerCase());
    const member = await guild.members.fetch(entry.userId).catch(() => null);

    // The account counts as ended when jfa-go deleted it, disabled it, or its
    // expiry is in the past (jfa-go deletes trials at user-expiry).
    const expiryMs = jfaUser && jfaUser.expiry > 0 ? jfaUser.expiry * 1000 : Number.POSITIVE_INFINITY;
    const ended = !jfaUser || jfaUser.disabled || expiryMs <= now;

    if (ended) {
      // "Paid once" if the bot ever classified the account as extended, or the
      // member still carries a subscription role.
      const wasPaid = entry.type === "extended" || (member ? memberHasSubscription(member) : false);
      if (member) {
        if (wasPaid) {
          // Subscription ended: drop Abo/Premium, but keep Mitglied (paid once).
          await removeSubscriptionRoles(guild, member);
          await member.send("Dein Jellyfin-Abo ist abgelaufen. Deine Mitglied-Rolle bleibt erhalten - melde dich beim Team, wenn du verlängern möchtest.").catch(() => undefined);
        } else if (entry.roleId && member.roles.cache.has(entry.roleId)) {
          // Pure trial that ended: remove the Trial role.
          await member.roles.remove(entry.roleId, "Trial beendet").catch(() => undefined);
        }
      }
      await logTrial(guild, new EmbedBuilder()
        .setTitle(wasPaid ? "Abo abgelaufen" : "Trial beendet")
        .setDescription(`<@${entry.userId}> - Jellyfin-Account \`${entry.jellyfinUsername}\` ist nicht mehr aktiv.`)
        .addFields({ name: "Typ", value: wasPaid ? "Abo (Mitglied bleibt)" : "Trial", inline: true })
        .setColor(0xe67e22)
        .setTimestamp());
      await trialStore.remove(guildId, entry.userId); // erlaubt wieder ein /trial
      continue;
    }

    // Account active: classify by live jfa-go expiry. Anything well beyond a
    // trial length has been topped up (paid) and is upgraded.
    const type = expiryMs - now > EXTENDED_THRESHOLD_MS ? "extended" : "trial";
    if (entry.type !== type) await trialStore.set(guildId, { ...entry, type });
    if (type === "extended" && member) {
      await applyUpgradeRoles(guild, member, entry.roleId);
    }
  }
}

async function handleMeinAccountCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  const entry = await trialStore.get(interaction.guild.id, interaction.user.id);
  if (!entry) {
    await interaction.reply({ ephemeral: true, content: "Du hast aktuell keinen verknüpften Jellyfin-Account. Nutze /trial für einen Testzugang." });
    return;
  }
  const lines = [
    `Jellyfin-Benutzer: \`${entry.jellyfinUsername}\``,
    `Typ: ${accountTypeLabel(entry.type)}`
  ];
  if (entry.type !== "extended") lines.push(`Trial laeuft ab: <t:${Math.floor(entry.expiresAt / 1000)}:R>`);
  await interaction.reply({ ephemeral: true, content: lines.join("\n") });
}

async function handleWhoisCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  if (!(await ensureCommandPermission(interaction, isModerator))) return;
  const target = interaction.options.getUser("user", true);
  const entry = await trialStore.get(interaction.guild.id, target.id);
  if (!entry) {
    await interaction.reply({ ephemeral: true, content: `${target.tag} hat keinen verknüpften Jellyfin-Account.` });
    return;
  }
  await interaction.reply({
    ephemeral: true,
    content: [
      `${target.tag} -> Jellyfin \`${entry.jellyfinUsername}\``,
      `Typ: ${accountTypeLabel(entry.type)}`,
      `Verknüpft seit: ${entry.createdAt}`
    ].join("\n")
  });
}

// Team lookup that shows the full Discord <-> Jellyfin link the bot logged when
// the account was created. Resolves from either side (Discord user or Jellyfin
// username) and cross-checks whether the account still exists on Jellyfin.
async function handleUserCheckCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return;
  if (!(await ensureCommandPermission(interaction, isModerator))) return;
  const guildId = interaction.guild.id;
  const targetUser = interaction.options.getUser("user", false);
  const usernameInput = interaction.options.getString("username", false)?.trim();
  if (!targetUser && !usernameInput) {
    await interaction.reply({ ephemeral: true, content: "Bitte gib einen Discord-Nutzer oder einen Jellyfin-Benutzernamen an." });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  let entry: TrialEntry | undefined;
  if (targetUser) {
    entry = await trialStore.get(guildId, targetUser.id);
  } else if (usernameInput) {
    const needle = usernameInput.toLowerCase();
    const all = await trialStore.allEntries();
    const match = all.find(({ guildId: g, entry: e }) => g === guildId && e.jellyfinUsername.toLowerCase() === needle)
      ?? all.find(({ entry: e }) => e.jellyfinUsername.toLowerCase() === needle);
    entry = match?.entry;
  }

  // Verify the account still exists on the live Jellyfin server.
  const jellyfinUsername = entry?.jellyfinUsername ?? usernameInput;
  let liveStatus = "";
  if (jellyfinUsername) {
    try {
      const live = await checkJellyfinUser(jellyfinUsername);
      liveStatus = !live.configured
        ? "Jellyfin-API nicht konfiguriert"
        : live.exists
          ? "auf Jellyfin vorhanden"
          : "auf Jellyfin nicht vorhanden";
    } catch {
      liveStatus = "Jellyfin nicht erreichbar";
    }
  }

  if (!entry) {
    const lines = targetUser
      ? [`${targetUser.tag} hat keinen vom Bot verknüpften Jellyfin-Account.`]
      : [`Keine Bot-Verknüpfung für Jellyfin-Benutzer \`${usernameInput}\` gefunden.`];
    if (liveStatus) lines.push(`Jellyfin-Status: ${liveStatus}`);
    await interaction.editReply(lines.join("\n"));
    return;
  }

  const linkedUser = targetUser ?? await interaction.client.users.fetch(entry.userId).catch(() => null);
  const discordLabel = linkedUser ? `${linkedUser} (${linkedUser.tag})` : `<@${entry.userId}> (ID ${entry.userId})`;
  const lines = [
    `Discord: ${discordLabel}`,
    `Jellyfin-Benutzer: \`${entry.jellyfinUsername}\``,
    `Typ: ${accountTypeLabel(entry.type)}`,
    `Verknüpft seit: ${entry.createdAt}`
  ];
  if (liveStatus) lines.push(`Jellyfin-Status: ${liveStatus}`);
  if (entry.type !== "extended") lines.push(`Trial läuft ab: <t:${Math.floor(entry.expiresAt / 1000)}:R>`);
  await interaction.editReply(lines.join("\n"));
}

function pruneEphemeralState() {
  const now = Date.now();
  for (const [userId, messages] of recentMessages) {
    const fresh = messages.filter((item) => now - item.at <= MODERATION_WINDOW_MS);
    if (fresh.length) recentMessages.set(userId, fresh);
    else recentMessages.delete(userId);
  }
  for (const [key, at] of moderationCooldowns) {
    if (now - at > MODERATION_COOLDOWN_MS) moderationCooldowns.delete(key);
  }
  for (const [id, suggestion] of pendingReplySuggestions) {
    if (now - suggestion.createdAt > PENDING_ACTION_TTL_MS) pendingReplySuggestions.delete(id);
  }
  for (const [id, draft] of pendingFaqDrafts) {
    if (now - draft.createdAt > PENDING_ACTION_TTL_MS) pendingFaqDrafts.delete(id);
  }
}

client.once(Events.ClientReady, async () => {
  await store.load();
  await ticketStore.load();
  await supportStore.load();
  await faqStore.load();
  await statsStore.load();
  await trialStore.load();
  await setupStore.load();
  await registerCommands();
  for (const guild of client.guilds.cache.values()) {
    await ensureTicketEntryInstructions(guild).catch(() => undefined);
  }
  await checkTicketFollowUps().catch((error) => {
    console.error("Ticket follow-up check failed", error);
    void logErrorToDiscord({
      title: "Ticket follow-up check failed",
      error
    });
  });
  setInterval(() => {
    void checkTicketFollowUps().catch((error) => {
      console.error("Ticket follow-up check failed", error);
      void logErrorToDiscord({
        title: "Ticket follow-up check failed",
        error
      });
    });
  }, config.TICKET_FOLLOWUP_CHECK_MINUTES * 60_000);
  setInterval(pruneEphemeralState, EPHEMERAL_PRUNE_INTERVAL_MS);
  setInterval(() => {
    void updateAllStats();
  }, Math.max(10, config.STATS_REFRESH_MINUTES) * 60_000);
  void updateAllStats();
  setInterval(() => {
    void expireTrials().catch((error) => console.error("[trial] expire failed", error));
  }, 5 * 60_000);
  void expireTrials();
  for (const guild of client.guilds.cache.values()) {
    await ensureAccountRoles(guild).catch(() => undefined);
  }
  setInterval(() => {
    void syncAccounts().catch((error) => console.error("[accounts] sync failed", error));
  }, 60 * 60_000);
  void syncAccounts();
  console.log(`Discord bot online as ${client.user?.tag}.`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!config.ENABLE_MEMBER_MONITORING && !config.ENABLE_NEW_ACCOUNT_PROTECTION) return;
  await store.recordJoin(member.id);

  if (config.ENABLE_MEMBER_MONITORING && config.DISCORD_MEMBER_ROLE_ID) {
    await member.roles.add(config.DISCORD_MEMBER_ROLE_ID, "Auto role for new Discord member").catch(() => undefined);
  }

  const ageDays = accountAgeDays(member.user);
  const newAccount = config.ENABLE_NEW_ACCOUNT_PROTECTION && ageDays < config.NEW_ACCOUNT_WARN_DAYS;
  const strictNew = config.ENABLE_NEW_ACCOUNT_PROTECTION && ageDays < config.NEW_ACCOUNT_STRICT_DAYS;

  if (strictNew && config.DISCORD_NEW_ACCOUNT_REVIEW_ROLE_ID) {
    await member.roles.add(config.DISCORD_NEW_ACCOUNT_REVIEW_ROLE_ID, "Sehr neuer Account: Review-Rolle").catch(() => undefined);
  }

  let timeoutApplied = false;
  if (strictNew && config.NEW_ACCOUNT_STRICT_TIMEOUT_MINUTES > 0 && member.moderatable) {
    await member.timeout(
      config.NEW_ACCOUNT_STRICT_TIMEOUT_MINUTES * 60_000,
      `Sehr neuer Account (${ageDays} Tage)`
    ).catch(() => undefined);
    timeoutApplied = true;
  }

  await logToDiscord(member.guild, new EmbedBuilder()
    .setTitle(newAccount ? "Neuer Account beigetreten" : "User beigetreten")
    .setDescription(`${member.user.tag} (${member.id})`)
    .addFields(
      { name: "Account-Alter", value: `${ageDays} Tage`, inline: true },
      { name: "Prüfung", value: strictNew ? "Streng" : newAccount ? "Beobachten" : "Normal", inline: true },
      { name: "Aktion", value: timeoutApplied ? `Timeout ${config.NEW_ACCOUNT_STRICT_TIMEOUT_MINUTES} Minuten` : "Keine", inline: true }
    )
    .setColor(0x2ecc71)
    .setTimestamp());
});

client.on(Events.GuildMemberRemove, async (member) => {
  if (!config.ENABLE_MEMBER_MONITORING) return;
  await store.recordLeave(member.id);
  await logToDiscord(member.guild, new EmbedBuilder()
    .setTitle("User verlassen")
    .setDescription(`${member.user.tag} (${member.id})`)
    .setColor(0xe67e22)
    .setTimestamp());
});

async function handleMessageCreate(message: Message) {
  if (!message.guild || message.author.bot) return;
  await store.recordMessage(message.author.id, message.channel.id);
  await recordTicketChannelActivity(message);

  // Tickets and the support entry channel are exactly where users legitimately
  // paste links, error text and account details, so auto-moderation must not run
  // there. Entry-channel messages are turned into a ticket first.
  const inTicketChannel = Boolean(await ticketStore.getByChannel(message.guild.id, message.channelId));
  const inEntryChannel = await isTicketEntryChannel(message.guild, message.channelId);

  if (inEntryChannel) {
    if (await handleTicketEntryMessage(message)) return;
  }

  if (!inTicketChannel && !inEntryChannel) {
    if (await handleInviteProtectionMessage(message)) return;
    if (await handleScamPhraseMessage(message)) return;
    if (await handleLinkFilterMessage(message)) return;
    if (await handleAdvancedAntiSpamMessage(message)) return;
  }

  if ((!config.ENABLE_MESSAGE_QA && !isOpenAiAssistantReady()) || !client.user) return;
  const mentioned = message.mentions.users.has(client.user.id);
  const prefixed = message.content.toLowerCase().startsWith("jellybot ");
  if (!mentioned && !prefixed) return;

  const question = stripBotMention(message.content);
  const answer = await answerAnyQuestion(question);
  if (answer) {
    await message.reply(answer.answer);
    return;
  }

  if (isOpenAiAssistantReady()) {
    await sendTypingIfPossible(message.channel);
    try {
      if (await answerWithAiAssistant({
        guild: message.guild,
        channelId: message.channelId,
        channelName: readableChannelName(message.channel),
        user: message.author,
        question,
        reply: (payload) => message.reply(payload)
      })) return;
    } catch (error) {
      console.error("AI assistant failed", error);
      await logErrorToDiscord({
        guild: message.guild,
        title: "AI assistant failed",
        error,
        context: {
          user: message.author.tag,
          userId: message.author.id,
          channelId: message.channelId
        }
      });
      await message.reply("Der AI-Assistent ist gerade nicht erreichbar. Ich habe den Fehler im Bot-Log gespeichert.").catch(() => undefined);
      return;
    }
  }

  await message.reply(`Ich kenne diese Frage noch nicht. Themen: ${(await allFaqTopics()).join(", ")}`);
}

client.on(Events.MessageCreate, (message) => {
  void handleMessageCreate(message).catch((error) => {
    console.error("Message handler failed", error);
    void logErrorToDiscord({
      guild: message.guild,
      title: "Message handler failed",
      error,
      context: {
        user: message.author.tag,
        userId: message.author.id,
        channelId: message.channelId,
        messageId: message.id
      }
    });
  });
});

async function handleInteractionCreate(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "faq") {
      const focused = interaction.options.getFocused();
      const choices = (await searchAllFaqItems(String(focused), 8)).map((item) => ({
        name: item.title,
        value: item.title
      }));
      await interaction.respond(choices);
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === TICKET_CREATE_BUTTON_ID) {
      await handleTicketCreateButton(interaction);
    }
    if (interaction.customId === TICKET_CLOSE_BUTTON_ID) {
      await handleTicketCloseButton(interaction);
    }
    if (interaction.customId === AI_LIBRARY_SCAN_BUTTON_ID) {
      await handleLibraryScanButton(interaction);
    }
    if (interaction.customId.startsWith(AI_SUGGEST_SEND_PREFIX)) {
      await handleSendSuggestionButton(interaction, interaction.customId.slice(AI_SUGGEST_SEND_PREFIX.length));
    }
    if (interaction.customId.startsWith(AI_SUGGEST_DISCARD_PREFIX)) {
      await handleDiscardSuggestionButton(interaction, interaction.customId.slice(AI_SUGGEST_DISCARD_PREFIX.length));
    }
    if (interaction.customId.startsWith(AI_FAQ_APPROVE_PREFIX)) {
      await handleApproveFaqButton(interaction, interaction.customId.slice(AI_FAQ_APPROVE_PREFIX.length));
    }
    if (interaction.customId.startsWith(AI_FAQ_DISCARD_PREFIX)) {
      await handleDiscardFaqButton(interaction, interaction.customId.slice(AI_FAQ_DISCARD_PREFIX.length));
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId === TICKET_CREATE_MODAL_ID) {
      await handleTicketCreateModal(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  if (interaction.commandName === "status") {
    await interaction.deferReply();
    const [jellyfin, sessions] = await Promise.allSettled([
      getJellyfinInfo(),
      getActiveSessionCount()
    ]);

    const embed = new EmbedBuilder()
      .setTitle("Jellyfin Status")
      .setColor(0x3498db)
      .addFields({
        name: "Jellyfin",
        value: jellyfin.status === "fulfilled" && jellyfin.value.configured
          ? `${jellyfin.value.info.ServerName ?? "Server"} ${jellyfin.value.info.Version ?? ""}`.trim()
          : "Nicht konfiguriert oder nicht erreichbar",
        inline: true
      }, {
        name: "Aktive Sessions",
        value: sessions.status === "fulfilled" && sessions.value !== undefined ? String(sessions.value) : "API-Key fehlt",
        inline: true
      })
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === "usercheck") {
    await handleUserCheckCommand(interaction);
    return;
  }

  if (interaction.commandName === "faq") {
    const question = interaction.options.getString("frage")?.trim();
    if (!question) {
      await interaction.reply({ ephemeral: true, content: `FAQ-Themen: ${(await allFaqTopics()).join(", ")}` });
      return;
    }
    const answer = await answerAnyQuestion(question);
    await interaction.reply({
      ephemeral: true,
      content: answer ? answer.answer : `Dazu habe ich noch keine passende Antwort. Themen: ${(await allFaqTopics()).join(", ")}`
    });
    return;
  }

  if (interaction.commandName === "payment-link") {
    await interaction.reply({ ephemeral: true, content: `Zahlungsseite: ${paymentUrl()}` });
    return;
  }

  if (interaction.commandName === "trial") {
    await handleTrialCommand(interaction);
    return;
  }

  if (interaction.commandName === "meinaccount") {
    await handleMeinAccountCommand(interaction);
    return;
  }

  if (interaction.commandName === "whois") {
    await handleWhoisCommand(interaction);
    return;
  }

  if (interaction.commandName === "serveraufbau") {
    if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageGuild)))) return;
    await handleServerAufbauCommand(interaction);
    return;
  }

  if (interaction.commandName === "ask") {
    const question = interaction.options.getString("frage", true).trim();
    await interaction.deferReply();
    if (!isOpenAiAssistantReady()) {
      await interaction.editReply("Der AI-Assistent ist noch nicht aktiviert. Setze OPENAI_API_KEY und ENABLE_AI_ASSISTANT=true.");
      return;
    }

    await answerWithAiAssistant({
      guild: interaction.guild,
      channelId: interaction.channelId,
      channelName: readableChannelName(interaction.channel),
      user: interaction.user,
      question,
      reply: (payload) => interaction.editReply(payload)
    });
    return;
  }

  if (interaction.commandName === "ticket") {
    await handleTicketCommand(interaction);
    return;
  }

  if (interaction.commandName === "support-status") {
    await handleSupportStatusCommand(interaction);
    return;
  }

  if (interaction.commandName === "stats") {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "setup") {
      if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageGuild)))) return;
      await handleStatsSetup(interaction);
      return;
    }
    if (subcommand === "refresh") {
      if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageGuild)))) return;
      await handleStatsRefresh(interaction);
      return;
    }
    if (subcommand === "remove") {
      if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageGuild)))) return;
      await handleStatsRemove(interaction);
      return;
    }

    const target = interaction.options.getUser("user") ?? interaction.user;
    const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
    if (target.id !== interaction.user.id && member && !isModerator(member)) {
      await interaction.reply({ ephemeral: true, content: "Du kannst nur deine eigenen Stats ansehen." });
      return;
    }
    const userStats = await store.getUser(target.id);
    await interaction.reply({
      ephemeral: true,
      content: [
        `Stats für ${target.tag}`,
        `Nachrichten: ${userStats.messages}`,
        `Warnungen: ${userStats.warnings}`,
        `Beitritte: ${userStats.joins}`,
        `Letzte Aktivitaet: ${userStats.lastSeenAt ?? "nie"}`
      ].join("\n")
    });
    return;
  }

  if (interaction.commandName === "warn") {
    if (!(await ensureCommandPermission(interaction, isModerator))) return;
    const targetUser = interaction.options.getUser("user", true);
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const reason = interaction.options.getString("grund", true);
    if (!(target instanceof GuildMember)) {
      await interaction.reply({ ephemeral: true, content: "User nicht gefunden." });
      return;
    }
    const result = await warnAndEscalate({
      guild: interaction.guild,
      member: target,
      reason,
      source: "manual",
      moderatorId: interaction.user.id
    });
    await interaction.reply({
      ephemeral: true,
      content: [
        `${target.user.tag} wurde verwarnt.`,
        `Warnungen: ${result.total}`,
        `ID: ${result.entry.id}`,
        result.timeoutApplied ? `Eskalation: Timeout ${result.timeoutMinutes} Minuten` : "Eskalation: keine"
      ].join("\n")
    });
    return;
  }

  if (interaction.commandName === "warnings") {
    if (!(await ensureCommandPermission(interaction, isModerator))) return;
    const target = interaction.options.getUser("user", true);
    const includeInactive = interaction.options.getBoolean("inaktive") ?? false;
    const warnings = await store.listWarnings(target.id, includeInactive);
    const activeCount = (await store.getUser(target.id)).warnings;
    const lines = warnings.slice(0, 10).map(formatWarningLine);
    await interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setTitle(`Warnungen für ${target.tag}`)
        .setDescription(lines.length ? lines.join("\n") : "Keine Warnungen gefunden.")
        .addFields(
          { name: "Aktiv", value: String(activeCount), inline: true },
          { name: "Angezeigt", value: String(warnings.length), inline: true }
        )
        .setColor(activeCount > 0 ? 0xf1c40f : 0x2ecc71)
        .setTimestamp()]
    });
    return;
  }

  if (interaction.commandName === "unwarn") {
    if (!(await ensureCommandPermission(interaction, isModerator))) return;
    const target = interaction.options.getUser("user", true);
    const warningId = interaction.options.getString("id")?.trim();
    const reason = interaction.options.getString("grund")?.trim();
    const removed = await store.removeWarning(target.id, warningId, interaction.user.id, reason);
    if (!removed) {
      await interaction.reply({
        ephemeral: true,
        content: warningId
          ? `Keine aktive Warnung mit ID ${warningId} gefunden.`
          : "Dieser User hat keine aktive Warnung."
      });
      return;
    }
    await interaction.reply({
      ephemeral: true,
      content: `Warnung ${removed.entry.id} von ${target.tag} wurde entfernt. Aktive Warnungen: ${removed.total}`
    });
    await logToDiscord(interaction.guild, new EmbedBuilder()
      .setTitle("Warnung entfernt")
      .setDescription(`<@${target.id}>: Warnung ${removed.entry.id}`)
      .addFields(
        { name: "Entfernt von", value: `<@${interaction.user.id}>`, inline: true },
        { name: "Aktive Warnungen", value: String(removed.total), inline: true },
        { name: "Grund", value: reason || "Keine Angabe" }
      )
      .setColor(0x2ecc71)
      .setTimestamp());
    return;
  }

  if (interaction.commandName === "timeout") {
    if (!(await ensureCommandPermission(interaction, isModerator))) return;
    const targetUser = interaction.options.getUser("user", true);
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const minutes = interaction.options.getInteger("minuten", true);
    const reason = interaction.options.getString("grund") ?? "Moderation";
    if (!(target instanceof GuildMember) || !target.moderatable) {
      await interaction.reply({ ephemeral: true, content: "Ich kann diesen User nicht timeouten." });
      return;
    }
    await target.timeout(minutes * 60_000, reason);
    await interaction.reply({ ephemeral: true, content: `${target.user.tag} hat einen Timeout für ${minutes} Minuten erhalten.` });
    await logToDiscord(interaction.guild, new EmbedBuilder()
      .setTitle("Timeout")
      .setDescription(`${target.user.tag}: ${reason}`)
      .addFields({ name: "Dauer", value: `${minutes} Minuten`, inline: true })
      .setColor(0xe74c3c)
      .setTimestamp());
    return;
  }

  if (interaction.commandName === "announce") {
    if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageMessages)))) return;
    const channel = interaction.options.getChannel("kanal", true);
    const text = interaction.options.getString("text", true);
    const target = await interaction.guild.channels.fetch(channel.id);
    if (!canSend(target)) {
      await interaction.reply({ ephemeral: true, content: "Der Zielkanal muss ein Textkanal sein." });
      return;
    }
    await target.send({ content: text });
    await interaction.reply({ ephemeral: true, content: "Ankündigung gesendet." });
    return;
  }

  if (interaction.commandName === "setup") {
    if (!(await ensureCommandPermission(interaction, (member) => memberHasGuildPermission(member, PermissionFlagsBits.ManageGuild)))) return;
    await interaction.deferReply({ ephemeral: true });
    const created = await setupGuild(interaction.guild);
    await interaction.editReply(created.length ? `Erstellt:\n${created.join("\n")}` : "Alles war bereits vorhanden.");
  }
}

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteractionCreate(interaction).catch(async (error) => {
    console.error("Interaction handler failed", error);
    await logErrorToDiscord({
      guild: interaction.guild,
      title: "Interaction handler failed",
      error,
      context: {
        interactionType: interaction.type,
        command: interaction.isChatInputCommand() ? interaction.commandName : undefined,
        customId: "customId" in interaction ? interaction.customId : undefined,
        user: interaction.user.tag,
        userId: interaction.user.id,
        channelId: interaction.channelId
      }
    });
    if (!interaction.isRepliable()) return;

    const content = "Dabei ist ein Fehler passiert. Ich habe ihn im Bot-Log gespeichert.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ ephemeral: true, content }).catch(() => undefined);
      return;
    }

    await interaction.reply({ ephemeral: true, content }).catch(() => undefined);
  });
});

client.login(config.DISCORD_TOKEN);
