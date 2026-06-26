import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder
} from "discord.js";
import { ticketCategories } from "./ticket-categories.js";

export const commandBuilders = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Zeigt API- und Jellyfin-Status."),
  new SlashCommandBuilder()
    .setName("usercheck")
    .setDescription("Prueft, ob ein Jellyfin-Benutzer existiert.")
    .addStringOption((option) => option
      .setName("username")
      .setDescription("Jellyfin-Benutzername")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("faq")
    .setDescription("Beantwortet typische Fragen.")
    .addStringOption((option) => option
      .setName("frage")
      .setDescription("Deine Frage")
      .setAutocomplete(true)
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("payment-link")
    .setDescription("Sendet den Link zur Zahlungsseite."),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Fragt den Jellyfin-Assistenten.")
    .addStringOption((option) => option
      .setName("frage")
      .setDescription("Was soll der Bot pruefen oder beantworten?")
      .setMaxLength(800)
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Oeffnet und verwaltet Support-Tickets.")
    .addSubcommand((subcommand) => subcommand
      .setName("create")
      .setDescription("Erstellt ein privates Support-Ticket.")
      .addStringOption((option) => {
        const withChoices = option
          .setName("kategorie")
          .setDescription("Welche Art von Hilfe brauchst du?")
          .setRequired(true);
        for (const category of ticketCategories) {
          withChoices.addChoices({ name: category.label, value: category.id });
        }
        return withChoices;
      })
      .addStringOption((option) => option
        .setName("thema")
        .setDescription("Worum geht es?")
        .setMaxLength(80)
        .setRequired(true))
      .addStringOption((option) => option
        .setName("beschreibung")
        .setDescription("Optional: kurze Beschreibung")
        .setMaxLength(600)
        .setRequired(false)))
    .addSubcommand((subcommand) => subcommand
      .setName("close")
      .setDescription("Schliesst das aktuelle Ticket.")
      .addStringOption((option) => option
        .setName("grund")
        .setDescription("Optional: Grund")
        .setMaxLength(300)
        .setRequired(false)))
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Fuegt einen User zum aktuellen Ticket hinzu.")
      .addUserOption((option) => option
        .setName("user")
        .setDescription("User")
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Entfernt einen User aus dem aktuellen Ticket.")
      .addUserOption((option) => option
        .setName("user")
        .setDescription("User")
        .setRequired(true)))
    .addSubcommand((subcommand) => subcommand
      .setName("list")
      .setDescription("Listet offene Tickets fuer das Team."))
    .addSubcommand((subcommand) => subcommand
      .setName("summary")
      .setDescription("Erstellt eine AI-Zusammenfassung des aktuellen Tickets."))
    .addSubcommand((subcommand) => subcommand
      .setName("suggest")
      .setDescription("Erstellt einen AI-Antwortvorschlag fuer das aktuelle Ticket.")),
  new SlashCommandBuilder()
    .setName("support-status")
    .setDescription("Zeigt oder setzt die Support-Verfuegbarkeit.")
    .addSubcommand((subcommand) => subcommand
      .setName("view")
      .setDescription("Zeigt die aktuelle Support-Verfuegbarkeit."))
    .addSubcommand((subcommand) => subcommand
      .setName("set")
      .setDescription("Setzt die Support-Verfuegbarkeit fuer den Server.")
      .addStringOption((option) => option
        .setName("status")
        .setDescription("Aktueller Status")
        .addChoices(
          { name: "Online", value: "online" },
          { name: "Beschaeftigt", value: "busy" },
          { name: "Offline", value: "offline" }
        )
        .setRequired(true))
      .addStringOption((option) => option
        .setName("nachricht")
        .setDescription("Optionaler Hinweis")
        .setMaxLength(240)
        .setRequired(false))),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Zeigt Aktivitaetsdaten fuer dich oder einen User.")
    .addUserOption((option) => option
      .setName("user")
      .setDescription("User")
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Verwarnt einen User und schreibt es ins Log.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("User")
      .setRequired(true))
    .addStringOption((option) => option
      .setName("grund")
      .setDescription("Grund")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("Zeigt den Warnverlauf eines Users.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("User")
      .setRequired(true))
    .addBooleanOption((option) => option
      .setName("inaktive")
      .setDescription("Auch entfernte Warnungen anzeigen")
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Entfernt die letzte oder eine bestimmte aktive Warnung.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("User")
      .setRequired(true))
    .addStringOption((option) => option
      .setName("id")
      .setDescription("Optional: Warnungs-ID aus /warnings")
      .setRequired(false))
    .addStringOption((option) => option
      .setName("grund")
      .setDescription("Optional: Grund fuer die Ruecknahme")
      .setMaxLength(240)
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Setzt einen Discord-Timeout fuer einen User.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("User")
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName("minuten")
      .setDescription("Dauer in Minuten")
      .setMinValue(1)
      .setMaxValue(10080)
      .setRequired(true))
    .addStringOption((option) => option
      .setName("grund")
      .setDescription("Grund")
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Sendet eine Ankuendigung in einen Textkanal.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((option) => option
      .setName("kanal")
      .setDescription("Zielkanal")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true))
    .addStringOption((option) => option
      .setName("text")
      .setDescription("Nachricht")
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Erstellt Standard-Kanaele und Rollen fuer den Jellyfin-Discord.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

export const commands = commandBuilders.map((command) => command.toJSON());
