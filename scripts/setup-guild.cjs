const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits
} = require("discord.js");

const config = {
  guildId: process.env.DISCORD_GUILD_ID || "",
  categoryPrefix: "",
  roles: {
    guest: "Gast",
    member: "Jellyfin Mitglied",
    support: "Support",
    moderator: "Moderator",
    admin: "Admin",
    muted: "Stumm"
  }
};
const TICKET_CREATE_BUTTON_ID = "ticket:create";

function ticketEntryEmbed() {
  return new EmbedBuilder()
    .setTitle("Support-Tickets")
    .setDescription([
      "Bitte oeffne fuer Support ein privates Ticket.",
      "",
      "**So geht es:**",
      "1. Klicke unten auf `Ticket oeffnen`.",
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
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(TICKET_CREATE_BUTTON_ID)
        .setLabel("Ticket oeffnen")
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

const categorySpecs = [
  {
    name: "START",
    channels: [
      { name: "willkommen", mode: "readonly", topic: "Startpunkt fuer neue Mitglieder." },
      { name: "regeln", mode: "readonly", topic: "Serverregeln und Verhalten." },
      { name: "ankuendigungen", mode: "readonly", topic: "Wichtige News rund um Jellyfin und den Server." },
      { name: "server-status", mode: "readonly", topic: "Statusmeldungen zu Jellyfin, Portal und Wartungen." }
    ]
  },
  {
    name: "JELLYFIN",
    channels: [
      { name: "zugang-und-zahlung", mode: "readonly", topic: "Infos zu Zugang, Zahlung und Laufzeit." },
      { name: "user-check", mode: "public", topic: "Nutze /usercheck und /payment-link fuer deinen Zugang." },
      { name: "app-hilfe", mode: "public", topic: "Hilfe zu Jellyfin Apps, Login und Geraeten." },
      { name: "stream-probleme", mode: "public", topic: "Support fuer Buffering, Qualitaet und Wiedergabe." },
      { name: "medien-wuensche", mode: "public", topic: "Wuensche und Vorschlaege fuer neue Inhalte." }
    ]
  },
  {
    name: "SUPPORT",
    channels: [
      { name: "support", mode: "public", topic: "Oeffentlicher Support. Keine Passwoerter oder Tokens posten." },
      { name: "support-log", mode: "team", topic: "Interne Support-Notizen und Eskalationen." },
      { name: "support-voice", type: ChannelType.GuildVoice, mode: "public", topic: "Voice-Support bei Bedarf." }
    ]
  },
  {
    name: "COMMUNITY",
    channels: [
      { name: "lounge", mode: "public", topic: "Allgemeiner Chat." },
      { name: "filme-und-serien", mode: "public", topic: "Austausch ueber Filme und Serien." },
      { name: "empfehlungen", mode: "public", topic: "Empfehlungen aus der Community." },
      { name: "watch-party", type: ChannelType.GuildVoice, mode: "public", topic: "Gemeinsam schauen und quatschen." }
    ]
  },
  {
    name: "TEAM",
    mode: "team",
    channels: [
      { name: "team-chat", mode: "team", topic: "Interner Team-Chat." },
      { name: "mod-log", mode: "team", topic: "Moderations- und Bot-Logs." },
      { name: "bot-log", mode: "team", topic: "Technische Bot-Meldungen." },
      { name: "server-admin", mode: "admin", topic: "Admin-only Bereich." }
    ]
  }
];

const basicPermissions =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.UseApplicationCommands;

const guestPermissions =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.UseApplicationCommands;

const moderatorPermissions =
  basicPermissions |
  PermissionFlagsBits.ModerateMembers;

const limitedAdminPermissions =
  moderatorPermissions |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.MentionEveryone;

function parseEnvFile() {
  const fs = require("fs");
  const path = require("path");
  const root = path.resolve(__dirname, "..", "..");
  const envPath = path.join(root, "infra", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function overwrites(guild, roles, mode) {
  const everyone = guild.roles.everyone.id;
  const botId = guild.client.user.id;
  const muted = roles.muted.id;
  const support = roles.support.id;
  const moderator = roles.moderator.id;
  const admin = roles.admin.id;

  const base = [
    {
      id: botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages
      ]
    },
    {
      id: muted,
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Speak
      ]
    }
  ];

  if (mode === "team") {
    return [
      { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: support, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: moderator, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: admin, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] },
      ...base
    ];
  }

  if (mode === "admin") {
    return [
      { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: admin, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] },
      ...base
    ];
  }

  if (mode === "readonly") {
    return [
      { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
      { id: support, allow: [PermissionFlagsBits.SendMessages] },
      { id: moderator, allow: [PermissionFlagsBits.SendMessages] },
      { id: admin, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] },
      ...base
    ];
  }

  return [
    { id: everyone, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: support, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: moderator, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: admin, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] },
    ...base
  ];
}

async function ensureRole(guild, name, options = {}) {
  const existing = guild.roles.cache.find((role) => role.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (options.permissions !== undefined && existing.editable) {
      await existing.edit({ permissions: options.permissions, color: options.color ?? existing.color }).catch(() => null);
    }
    return existing;
  }
  return guild.roles.create({
    name,
    color: options.color,
    permissions: options.permissions ?? 0n,
    reason: "Jellyfin Discord setup"
  });
}

async function ensureCategory(guild, name, roles, mode) {
  const existing = guild.channels.cache.find((channel) =>
    channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    await existing.permissionOverwrites.set(overwrites(guild, roles, mode || "public")).catch(() => null);
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites(guild, roles, mode || "public"),
    reason: "Jellyfin Discord setup"
  });
}

async function ensureChannel(guild, category, roles, spec) {
  const existing = guild.channels.cache.find((channel) =>
    channel.name.toLowerCase() === spec.name.toLowerCase()
  );
  const type = spec.type ?? ChannelType.GuildText;
  if (existing) {
    await existing.setParent(category.id, { lockPermissions: false }).catch(() => null);
    await existing.permissionOverwrites.set(overwrites(guild, roles, spec.mode || "public")).catch(() => null);
    if ("setTopic" in existing && spec.topic) await existing.setTopic(spec.topic).catch(() => null);
    return existing;
  }
  return guild.channels.create({
    name: spec.name,
    type,
    parent: category.id,
    topic: type === ChannelType.GuildText ? spec.topic : undefined,
    permissionOverwrites: overwrites(guild, roles, spec.mode || "public"),
    reason: "Jellyfin Discord setup"
  });
}

async function sendStarterMessage(channel, marker, content) {
  if (!channel?.isTextBased()) return false;
  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  const legacyPrefixes = {
    "[HOJ_SETUP_WELCOME]": "**Willkommen bei House of Jellyfin**",
    "[HOJ_SETUP_RULES]": "**Regeln**",
    "[HOJ_SETUP_PAYMENT]": "**Zugang und Zahlung**",
    "[HOJ_SETUP_SUPPORT]": "**Support"
  };
  const legacyPrefix = legacyPrefixes[marker];
  const matchesStarter = (message) =>
    message.author.bot &&
    (
      message.content.includes(marker) ||
      (legacyPrefix && message.content.startsWith(legacyPrefix)) ||
      (marker === "[HOJ_SETUP_SUPPORT]" && message.embeds.some((embed) => embed.footer?.text === "HOJ_TICKET_ENTRY"))
    );
  const existing = recent?.find((message) =>
    matchesStarter(message)
  );
  const duplicates = recent?.filter((message) => existing && message.id !== existing.id && matchesStarter(message)) ?? [];
  for (const duplicate of duplicates.values()) {
    await duplicate.delete().catch(() => null);
  }

  if (existing) {
    await existing.edit(content).catch(() => null);
    await existing.pin().catch(() => null);
    return false;
  }
  const message = await channel.send(content);
  await message.pin().catch(() => null);
  return true;
}

async function positionRoles(roles) {
  const order = [
    roles.admin,
    roles.moderator,
    roles.support,
    roles.member,
    roles.guest,
    roles.muted
  ];

  for (let index = order.length - 1; index >= 0; index -= 1) {
    const role = order[index];
    if (!role?.editable) continue;
    await role.setPosition(order.length - index).catch(() => null);
  }
}

async function main() {
  parseEnvFile();
  if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN fehlt");

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Discord login timeout")), 20000);
    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      resolve();
    });
    client.login(process.env.DISCORD_TOKEN).catch(reject);
  });

  const guilds = [...client.guilds.cache.values()];
  const guild = config.guildId
    ? client.guilds.cache.get(config.guildId)
    : guilds.length === 1
      ? guilds[0]
      : null;

  if (!guild) {
    throw new Error(`Server nicht eindeutig gefunden. Gefundene Server: ${guilds.map((item) => item.name).join(", ")}`);
  }

  await guild.fetch();
  await guild.roles.fetch();
  await guild.channels.fetch();
  const roles = {
    guest: await ensureRole(guild, config.roles.guest, { color: 0x95a5a6, permissions: guestPermissions }),
    member: await ensureRole(guild, config.roles.member, { color: 0x2ecc71, permissions: basicPermissions }),
    support: await ensureRole(guild, config.roles.support, {
      color: 0x3498db,
      permissions: basicPermissions
    }),
    moderator: await ensureRole(guild, config.roles.moderator, {
      color: 0xe67e22,
      permissions: moderatorPermissions
    }),
    admin: await ensureRole(guild, config.roles.admin, {
      color: 0xe74c3c,
      permissions: limitedAdminPermissions
    }),
    muted: await ensureRole(guild, config.roles.muted, { color: 0x7f8c8d })
  };
  await positionRoles(roles);

  const createdOrUpdated = [];
  const channels = {};
  for (const categorySpec of categorySpecs) {
    const category = await ensureCategory(guild, categorySpec.name, roles, categorySpec.mode);
    createdOrUpdated.push(`Kategorie: ${category.name}`);
    for (const channelSpec of categorySpec.channels) {
      const channel = await ensureChannel(guild, category, roles, channelSpec);
      channels[channel.name] = channel;
      createdOrUpdated.push(`Kanal: #${channel.name}`);
    }
  }

  const messages = [
    ["willkommen", "[HOJ_SETUP_WELCOME]", [
      "**Willkommen bei House of Jellyfin**",
      "",
      "Hier findest du Zugang, Support und Statusinfos fuer den Jellyfin Server.",
      "Nuetzliche Befehle:",
      "`/status` zeigt den Serverstatus.",
      "`/usercheck` prueft deinen Jellyfin-Benutzernamen.",
      "`/payment-link` sendet dir die Zahlungsseite.",
      "",
      "Bitte poste keine Passwoerter, Tokens oder privaten Zahlungsdaten."
    ].join("\n")],
    ["regeln", "[HOJ_SETUP_RULES]", [
      "**Regeln**",
      "",
      "1. Freundlich bleiben.",
      "2. Keine Zugangsdaten, Tokens oder privaten Zahlungsinfos posten.",
      "3. Supportfragen mit Geraet, App, Jellyfin-Name und genauer Fehlermeldung stellen.",
      "4. Keine Spam-Nachrichten oder mehrfachen Pings.",
      "5. Teamentscheidungen respektieren."
    ].join("\n")],
    ["zugang-und-zahlung", "[HOJ_SETUP_PAYMENT]", [
      "**Zugang und Zahlung**",
      "",
      "Nutze `/payment-link`, um die Zahlungsseite zu oeffnen.",
      "Nach erfolgreicher Zahlung wird dein Jellyfin-Zugang automatisch verlaengert.",
      "Mit `/usercheck` kannst du pruefen, ob dein Jellyfin-Name erkannt wird."
    ].join("\n")],
    ["support", "[HOJ_SETUP_SUPPORT]", {
      content: "",
      embeds: [ticketEntryEmbed()],
      components: ticketEntryComponents()
    }]
  ];

  let sentMessages = 0;
  for (const [channelName, marker, content] of messages) {
    if (await sendStarterMessage(channels[channelName], marker, content)) sentMessages += 1;
  }

  console.log(`SETUP_GUILD=${guild.name} | ${guild.id}`);
  console.log(`ROLES=${Object.values(roles).map((role) => role.name).join(", ")}`);
  console.log(`UPDATED_ITEMS=${createdOrUpdated.length}`);
  console.log(`STARTER_MESSAGES_SENT=${sentMessages}`);

  await client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
