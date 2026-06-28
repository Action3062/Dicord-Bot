import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type TextChannel
} from "discord.js";
import type { SetupStore } from "./setup-store.js";

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
type RoleDef = {
  key: string;
  name: string;
  color: number;
  administrator?: boolean;
  permissions?: bigint[];
};

const ROLES: RoleDef[] = [
  { key: "owner", name: "👑 Owner", color: 0xe74c3c, administrator: true },
  {
    key: "admin",
    name: "🛡️ Admin",
    color: 0xe67e22,
    permissions: [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageChannels,
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.BanMembers,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ViewAuditLog
    ]
  },
  {
    key: "moderator",
    name: "🔧 Moderator",
    color: 0x3498db,
    permissions: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.KickMembers,
      PermissionFlagsBits.MuteMembers,
      PermissionFlagsBits.MoveMembers
    ]
  },
  { key: "support", name: "🎧 Support", color: 0x1abc9c, permissions: [PermissionFlagsBits.ManageMessages] },
  {
    key: "bot",
    name: "🤖 Bot",
    color: 0x95a5a6,
    permissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageMessages]
  },
  { key: "abonnent", name: "💎 Abonnent", color: 0x9b59b6 },
  { key: "trial", name: "🧪 Trial", color: 0xf1c40f },
  { key: "mitglied", name: "👤 Mitglied", color: 0x2ecc71 },
  { key: "muted", name: "🔇 Stummgeschaltet", color: 0x607d8b }
];

const TEAM_ROLE_KEYS = ["owner", "admin", "moderator", "support", "bot"];
const OWNER_ADMIN_KEYS = ["owner", "admin", "bot"];

// ---------------------------------------------------------------------------
// Channel structure
// ---------------------------------------------------------------------------
type View = "everyone" | "trial" | "abo" | "team" | "owneradmin";
type Write = "everyone" | "team" | "trial" | "abo" | "none";
type EmbedKind = "welcome" | "rules" | "faq" | "payment";

type ChannelDef = {
  key: string;
  name: string;
  voice?: boolean;
  view: View;
  write: Write;
  topic?: string;
  embed?: EmbedKind;
};

type CategoryDef = { key: string; name: string; channels: ChannelDef[] };

const STRUCTURE: CategoryDef[] = [
  {
    key: "information",
    name: "📌 INFORMATION",
    channels: [
      { key: "willkommen", name: "👋 willkommen", view: "everyone", write: "team", topic: "Begrüßung neuer Mitglieder auf dem Byteflix Discord.", embed: "welcome" },
      { key: "regeln", name: "📜 regeln", view: "everyone", write: "team", topic: "Offizielle Serverregeln und Verhaltenshinweise.", embed: "rules" },
      { key: "ankuendigungen", name: "📢 ankündigungen", view: "everyone", write: "team", topic: "Wichtige Neuigkeiten rund um Byteflix." },
      { key: "server-status", name: "🟢 server-status", view: "everyone", write: "team", topic: "Aktueller Status von Byteflix, Jellyfin und verbundenen Diensten." },
      { key: "wartungen", name: "📡 wartungen", view: "everyone", write: "team", topic: "Geplante Wartungen, Updates und technische Arbeiten." },
      { key: "stoerungen", name: "🚨 störungen", view: "everyone", write: "team", topic: "Aktuelle Ausfälle, bekannte Probleme und Einschränkungen." },
      { key: "faq", name: "❓ faq", view: "everyone", write: "team", topic: "Häufige Fragen und schnelle Antworten.", embed: "faq" },
      { key: "payments", name: "💳 payments", view: "everyone", write: "team", topic: "Hinweise zu Zahlungen, Abos und sicheren Zahlungswegen.", embed: "payment" }
    ]
  },
  {
    key: "community",
    name: "💬 COMMUNITY",
    channels: [
      { key: "allgemein", name: "💬 allgemein", view: "everyone", write: "everyone", topic: "Allgemeiner Austausch der Community." },
      { key: "byteflix-talk", name: "🎬 byteflix-talk", view: "everyone", write: "everyone", topic: "Filme, Serien und alles rund um Byteflix." },
      { key: "vorschlaege", name: "💡 vorschläge", view: "everyone", write: "everyone", topic: "Deine Ideen und Wünsche für Byteflix." },
      { key: "feedback", name: "⭐ feedback", view: "everyone", write: "everyone", topic: "Lob, Kritik und Rückmeldungen." },
      { key: "changelog", name: "🧾 changelog", view: "everyone", write: "team", topic: "Neuerungen und Änderungen an Byteflix." }
    ]
  },
  {
    key: "support",
    name: "🎟️ SUPPORT",
    channels: [
      { key: "support-erstellen", name: "🆘 support-erstellen", view: "everyone", write: "none", topic: "Erstelle hier per Button ein Support-Ticket." },
      { key: "tickets", name: "📩 tickets", view: "team", write: "team", topic: "Aktive Supportfälle (Team)." },
      { key: "hilfe", name: "📚 hilfe", view: "everyone", write: "team", topic: "Anleitungen und Hilfestellungen." },
      { key: "problem-melden", name: "⚠️ problem-melden", view: "everyone", write: "everyone", topic: "Melde hier ein Problem - das Team antwortet." },
      { key: "erledigte-tickets", name: "✅ erledigte-tickets", view: "team", write: "none", topic: "Archiv für abgeschlossene Supportfälle." }
    ]
  },
  {
    key: "trial",
    name: "🧪 TRIAL BEREICH",
    channels: [
      { key: "trial-info", name: "🧪 trial-info", view: "everyone", write: "team", topic: "Alles Wichtige zum Byteflix-Testzugang." },
      { key: "trial-beantragen", name: "🧪 trial-beantragen", view: "everyone", write: "everyone", topic: "Testzugang für Byteflix anfragen." },
      { key: "trial-zugang", name: "🚀 trial-zugang", view: "trial", write: "team", topic: "Zugangsinfos für Trial-Nutzer." },
      { key: "trial-fragen", name: "❓ trial-fragen", view: "trial", write: "trial", topic: "Fragen rund um deinen Testzugang." },
      { key: "trial-status", name: "⏰ trial-status", view: "trial", write: "team", topic: "Status und Restlaufzeit deines Trials." }
    ]
  },
  {
    key: "abo",
    name: "💎 ABO & PAYMENTS",
    channels: [
      { key: "abo-pakete", name: "📦 abo-pakete", view: "everyone", write: "team", topic: "Übersicht über verfügbare Byteflix-Abos und Vorteile." },
      { key: "zugang-beantragen", name: "🔐 zugang-beantragen", view: "everyone", write: "everyone", topic: "Zugang nach Abo, Trial oder Freischaltung beantragen." },
      { key: "abo-info", name: "💎 abo-info", view: "everyone", write: "team", topic: "Informationen rund um dein Byteflix-Abo." },
      { key: "abo-zugang", name: "🔐 abo-zugang", view: "abo", write: "team", topic: "Zugangsinfos für Abonnenten." },
      { key: "stream-hilfe", name: "📺 stream-hilfe", view: "abo", write: "abo", topic: "Hilfe beim Streaming für Abonnenten." },
      { key: "technische-hilfe", name: "🛠️ technische-hilfe", view: "abo", write: "abo", topic: "Technische Unterstützung für Abonnenten." },
      { key: "abo-ankuendigungen", name: "📢 abo-ankündigungen", view: "abo", write: "team", topic: "Ankündigungen für Abonnenten." }
    ]
  },
  {
    key: "team",
    name: "👥 TEAM BEREICH",
    channels: [
      { key: "team-chat", name: "👥 team-chat", view: "team", write: "team", topic: "Interner Team-Austausch." },
      { key: "team-aufgaben", name: "📋 team-aufgaben", view: "team", write: "team", topic: "Aufgaben und To-dos des Teams." },
      { key: "ticket-uebersicht", name: "🎫 ticket-übersicht", view: "team", write: "team", topic: "Überblick über offene Tickets." },
      { key: "interne-notizen", name: "📝 interne-notizen", view: "team", write: "team", topic: "Interne Notizen des Teams." }
    ]
  },
  {
    key: "logs",
    name: "🤖 BOT & LOGS",
    channels: [
      { key: "bot-commands", name: "🤖 bot-commands", view: "team", write: "team", topic: "Bot-Befehle für das Team." },
      { key: "bot-logs", name: "📜 bot-logs", view: "owneradmin", write: "team", topic: "Allgemeine Bot-Aktionen (Owner/Admin)." },
      { key: "moderation-logs", name: "🛡️ moderation-logs", view: "team", write: "team", topic: "Moderationsaktionen." },
      { key: "ticket-logs", name: "🎫 ticket-logs", view: "team", write: "team", topic: "Ticket-Aktivitäten." },
      { key: "payment-logs", name: "💳 payment-logs", view: "owneradmin", write: "team", topic: "Zahlungsbezogene Logs (Owner/Admin)." },
      { key: "member-logs", name: "👤 member-logs", view: "team", write: "team", topic: "Join/Leave und Mitglieder-Events." },
      { key: "system-logs", name: "⚙️ system-logs", view: "team", write: "team", topic: "System- und Fehlerlogs." }
    ]
  },
  {
    key: "voice",
    name: "🔊 VOICE",
    channels: [
      { key: "voice-allgemein", name: "🔊 Allgemein", voice: true, view: "everyone", write: "everyone" },
      { key: "voice-support", name: "🎧 Support-Warteraum", voice: true, view: "everyone", write: "everyone" },
      { key: "voice-team", name: "👥 Team-Voice", voice: true, view: "team", write: "team" }
    ]
  }
];

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------
type Overwrite = { id: string; allow?: bigint[]; deny?: bigint[] };

function buildOverwrites(def: ChannelDef, roleIds: Map<string, string>, everyoneId: string): Overwrite[] {
  const view = PermissionFlagsBits.ViewChannel;
  const history = PermissionFlagsBits.ReadMessageHistory;
  const sendPerms = def.voice
    ? [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
    : [PermissionFlagsBits.SendMessages];

  const overwrites: Overwrite[] = [];

  if (def.view === "everyone") {
    const deny = def.write === "everyone" ? [] : [...sendPerms];
    overwrites.push({ id: everyoneId, allow: [view], deny });
  } else {
    overwrites.push({ id: everyoneId, deny: [view] });
  }

  const mutedId = roleIds.get("muted");
  if (mutedId) {
    overwrites.push({
      id: mutedId,
      deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.Speak, PermissionFlagsBits.Connect]
    });
  }

  const grant = (key: string, canWrite: boolean) => {
    const id = roleIds.get(key);
    if (!id) return;
    const allow = [view, history];
    if (canWrite) allow.push(...sendPerms);
    overwrites.push({ id, allow });
  };

  if (def.view === "trial") grant("trial", def.write === "trial");
  if (def.view === "abo") grant("abo", def.write === "abo");

  const viewers = def.view === "owneradmin" ? OWNER_ADMIN_KEYS : TEAM_ROLE_KEYS;
  for (const key of viewers) grant(key, true);

  return overwrites;
}

// ---------------------------------------------------------------------------
// Embeds
// ---------------------------------------------------------------------------
const EMBED_MARKER = "BYTEFLIX_SETUP";

function buildEmbed(kind: EmbedKind): EmbedBuilder {
  const base = new EmbedBuilder().setColor(0x9b59b6).setFooter({ text: EMBED_MARKER });
  switch (kind) {
    case "welcome":
      return base
        .setTitle("👋 Willkommen bei Byteflix")
        .setDescription([
          "Schön, dass du da bist! Byteflix ist dein Streaming-Zugang über Jellyfin.",
          "",
          "• Lies dir zuerst die **📜 regeln** durch.",
          "• Hol dir einen **🧪 Testzugang** im Trial-Bereich.",
          "• Brauchst du Hilfe? Erstelle ein Ticket in **🆘 support-erstellen**."
        ].join("\n"));
    case "rules":
      return base
        .setTitle("📜 Serverregeln")
        .setDescription([
          "1. Sei respektvoll - kein Spam, keine Beleidigungen.",
          "2. Keine Weitergabe privater Zugangsdaten.",
          "3. Keine Zahlungsdaten öffentlich posten - nutze Tickets.",
          "4. Anfragen laufen über die dafür vorgesehenen Channels/Tickets.",
          "5. Anweisungen des Teams sind zu befolgen.",
          "",
          "Verstöße können zu Stummschaltung oder Ausschluss führen."
        ].join("\n"));
    case "faq":
      return base
        .setTitle("❓ Häufige Fragen")
        .setDescription([
          "**Wie bekomme ich einen Testzugang?** → In **🧪 trial-beantragen** bzw. per Bot.",
          "**Wie werde ich Abonnent?** → Siehe **📦 abo-pakete** und **🔐 zugang-beantragen**.",
          "**Wo finde ich Hilfe?** → **📚 hilfe** oder ein Ticket über **🆘 support-erstellen**.",
          "**Server-Status?** → **🟢 server-status** und **🚨 störungen**."
        ].join("\n"));
    case "payment":
      return base
        .setTitle("💳 Hinweise zu Zahlungen")
        .setDescription([
          "• Zahlungsdaten werden **niemals** im Discord erfasst.",
          "• Poste **keine** privaten Zugangs- oder Zahlungsdaten öffentlich.",
          "• Zugangs- und Zahlungsanfragen laufen über **Tickets** bzw. die dafür vorgesehenen Channels.",
          "• Bei Unsicherheiten wende dich an das Team."
        ].join("\n"));
  }
}

async function postEmbedOnce(channel: GuildBasedChannel, kind: EmbedKind) {
  if (channel.type !== ChannelType.GuildText) return;
  const textChannel = channel as TextChannel;
  const recent = await textChannel.messages.fetch({ limit: 20 }).catch(() => null);
  const already = recent?.some(
    (message) => message.author.id === channel.client.user?.id && message.embeds.some((embed) => embed.footer?.text === EMBED_MARKER)
  );
  if (already) return;
  await textChannel.send({ embeds: [buildEmbed(kind)] }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Idempotent ensure helpers (resolve by stored ID, then name, else create)
// ---------------------------------------------------------------------------
async function ensureRole(guild: Guild, setupStore: SetupStore, def: RoleDef) {
  const key = `byteflix:role:${def.key}`;
  const storedId = await setupStore.getId(guild.id, key);
  let role = storedId ? guild.roles.cache.get(storedId) ?? await guild.roles.fetch(storedId).catch(() => null) : null;
  if (!role) role = guild.roles.cache.find((item) => item.name.toLowerCase() === def.name.toLowerCase()) ?? null;

  let created = false;
  let degraded = false;
  if (!role) {
    const permissions = def.administrator ? [PermissionFlagsBits.Administrator] : def.permissions ?? [];
    role = await guild.roles.create({ name: def.name, color: def.color, permissions, reason: "Byteflix setup" }).catch(() => null);
    if (!role) {
      // A bot cannot grant a permission it does not hold itself (needs Administrator).
      // Fall back to creating the role without permissions so the build still completes.
      role = await guild.roles
        .create({ name: def.name, color: def.color, permissions: [], reason: "Byteflix setup (ohne Rechte)" })
        .catch(() => null);
      degraded = Boolean(role);
    }
    created = Boolean(role);
  }
  if (role) await setupStore.setId(guild.id, key, role.id);
  return { id: role?.id, created, degraded };
}

async function ensureCategory(guild: Guild, setupStore: SetupStore, def: CategoryDef) {
  const key = `byteflix:category:${def.key}`;
  const storedId = await setupStore.getId(guild.id, key);
  let category: GuildBasedChannel | null = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if (category?.type !== ChannelType.GuildCategory) {
    category = guild.channels.cache.find(
      (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === def.name.toLowerCase()
    ) ?? null;
  }

  let created = false;
  if (category?.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({ name: def.name, type: ChannelType.GuildCategory, reason: "Byteflix setup" });
    created = true;
  }
  await setupStore.setId(guild.id, key, category.id);
  return { category: category as CategoryChannel, created };
}

async function ensureChannel(
  guild: Guild,
  setupStore: SetupStore,
  parentId: string,
  def: ChannelDef,
  roleIds: Map<string, string>,
  everyoneId: string
) {
  const key = `byteflix:channel:${def.key}`;
  const overwrites = buildOverwrites(def, roleIds, everyoneId);
  const storedId = await setupStore.getId(guild.id, key);
  let channel: GuildBasedChannel | null = storedId ? await guild.channels.fetch(storedId).catch(() => null) : null;
  if (!channel) {
    const wantedType = def.voice ? ChannelType.GuildVoice : ChannelType.GuildText;
    channel = guild.channels.cache.find(
      (item) => item.type === wantedType && item.name.toLowerCase() === def.name.toLowerCase() && item.parentId === parentId
    ) ?? null;
  }

  let created = false;
  if (!channel) {
    channel = await guild.channels.create({
      name: def.name,
      type: def.voice ? ChannelType.GuildVoice : ChannelType.GuildText,
      parent: parentId,
      topic: def.voice ? undefined : def.topic,
      permissionOverwrites: overwrites,
      reason: "Byteflix setup"
    });
    created = true;
  } else {
    const editable = channel as unknown as {
      setParent?: (id: string, options?: { lockPermissions?: boolean }) => Promise<unknown>;
      setTopic?: (topic: string, reason?: string) => Promise<unknown>;
      permissionOverwrites?: { set: (overwrites: Overwrite[], reason?: string) => Promise<unknown> };
    };
    await editable.setParent?.(parentId, { lockPermissions: false }).catch(() => undefined);
    if (!def.voice && def.topic) await editable.setTopic?.(def.topic, "Byteflix setup").catch(() => undefined);
    await editable.permissionOverwrites?.set(overwrites, "Byteflix setup").catch(() => undefined);
  }
  await setupStore.setId(guild.id, key, channel.id);
  return { channel, created };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export type ByteflixSetupResult = {
  summary: string[];
  failures: string[];
  channelIdByKey: Map<string, string>;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Unbekannter Fehler";
}

export async function buildByteflixServer(guild: Guild, setupStore: SetupStore): Promise<ByteflixSetupResult> {
  const summary: string[] = [];
  const failures: string[] = [];
  const everyoneId = guild.roles.everyone.id;
  const channelIdByKey = new Map<string, string>();

  const roleIds = new Map<string, string>();
  for (const def of ROLES) {
    try {
      const { id, created, degraded } = await ensureRole(guild, setupStore, def);
      if (id) roleIds.set(def.key, id);
      if (created) summary.push(`Rolle: ${def.name}${degraded ? " (ohne Rechte)" : ""}`);
      if (!id) failures.push(`Rolle ${def.name} konnte nicht erstellt werden (Bot-Rechte?)`);
      else if (degraded) failures.push(`Rolle ${def.name} ohne Rechte angelegt - Bot braucht Administrator`);
    } catch (error) {
      failures.push(`Rolle ${def.name}: ${errorText(error)}`);
    }
  }

  for (const cat of STRUCTURE) {
    let categoryId: string;
    try {
      const { category, created } = await ensureCategory(guild, setupStore, cat);
      categoryId = category.id;
      if (created) summary.push(`Kategorie: ${cat.name}`);
    } catch (error) {
      failures.push(`Kategorie ${cat.name}: ${errorText(error)}`);
      continue;
    }
    for (const def of cat.channels) {
      try {
        const result = await ensureChannel(guild, setupStore, categoryId, def, roleIds, everyoneId);
        channelIdByKey.set(def.key, result.channel.id);
        if (result.created) summary.push(`Kanal: ${def.name}`);
        if (def.embed) await postEmbedOnce(result.channel, def.embed);
      } catch (error) {
        failures.push(`Kanal ${def.name}: ${errorText(error)}`);
      }
    }
  }

  return { summary, failures, channelIdByKey };
}
