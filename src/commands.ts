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
    .setDescription("Zeigt die Verknüpfung zwischen Discord-Nutzer und Jellyfin-Account (Team).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option
      .setName("user")
      .setDescription("Discord-Nutzer")
      .setRequired(false))
    .addStringOption((option) => option
      .setName("username")
      .setDescription("Jellyfin-Benutzername (Rückwärtssuche)")
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("faq")
    .setDescription("Beantwortet typische Fragen.")
    .addStringOption((option) => option
      .setName("frage")
      .setDescription("Deine Frage")
      .setAutocomplete(true)
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Fragt den Jellyfin-Assistenten.")
    .addStringOption((option) => option
      .setName("frage")
      .setDescription("Was soll der Bot prüfen oder beantworten?")
      .setMaxLength(800)
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Öffnet und verwaltet Support-Tickets.")
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
      .setDescription("Schließt das aktuelle Ticket.")
      .addStringOption((option) => option
        .setName("grund")
        .setDescription("Optional: Grund")
        .setMaxLength(300)
        .setRequired(false)))
    .addSubcommand((subcommand) => subcommand
      .setName("add")
      .setDescription("Fügt einen User zum aktuellen Ticket hinzu.")
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
      .setDescription("Listet offene Tickets für das Team."))
    .addSubcommand((subcommand) => subcommand
      .setName("summary")
      .setDescription("Erstellt eine AI-Zusammenfassung des aktuellen Tickets."))
    .addSubcommand((subcommand) => subcommand
      .setName("suggest")
      .setDescription("Erstellt einen AI-Antwortvorschlag für das aktuelle Ticket.")),
  new SlashCommandBuilder()
    .setName("support-status")
    .setDescription("Zeigt oder setzt die Support-Verfügbarkeit.")
    .addSubcommand((subcommand) => subcommand
      .setName("view")
      .setDescription("Zeigt die aktuelle Support-Verfügbarkeit."))
    .addSubcommand((subcommand) => subcommand
      .setName("set")
      .setDescription("Setzt die Support-Verfügbarkeit für den Server.")
      .addStringOption((option) => option
        .setName("status")
        .setDescription("Aktueller Status")
        .addChoices(
          { name: "Online", value: "online" },
          { name: "Beschäftigt", value: "busy" },
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
    .setDescription("Aktivitaets- und Jellyfin-Bibliotheks-Statistiken.")
    .addSubcommand((subcommand) => subcommand
      .setName("activity")
      .setDescription("Zeigt Aktivitaetsdaten für dich oder einen User.")
      .addUserOption((option) => option
        .setName("user")
        .setDescription("User")
        .setRequired(false)))
    .addSubcommand((subcommand) => subcommand
      .setName("setup")
      .setDescription("Erstellt/aktualisiert die Jellyfin-Statistik-Sprachkanäle."))
    .addSubcommand((subcommand) => subcommand
      .setName("refresh")
      .setDescription("Aktualisiert die Statistik-Kanäle sofort."))
    .addSubcommand((subcommand) => subcommand
      .setName("remove")
      .setDescription("Entfernt die Statistik-Kanäle wieder.")),
  new SlashCommandBuilder()
    .setName("trial")
    .setDescription("Erstellt dir einen zeitlich begrenzten Jellyfin-Testzugang."),
  new SlashCommandBuilder()
    .setName("meinaccount")
    .setDescription("Zeigt deinen verknüpften Jellyfin-Account und Status."),
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
      .setDescription("Optional: Grund für die Rücknahme")
      .setMaxLength(240)
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Setzt einen Discord-Timeout für einen User.")
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
    .setDescription("Sendet eine Ankündigung in einen Textkanal.")
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
    .setName("aboinfo")
    .setDescription("Postet einen Abo-Channel-Beitrag (Pakete / Info / Zugang).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) => option
      .setName("typ")
      .setDescription("Welcher Beitrag?")
      .addChoices(
        { name: "Pakete & Preise", value: "pakete" },
        { name: "Abo-Info", value: "info" },
        { name: "Abo-Zugang", value: "zugang" }
      )
      .setRequired(true))
    .addChannelOption((option) => option
      .setName("kanal")
      .setDescription("Zielkanal (Standard: aktueller Kanal)")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false)),
  new SlashCommandBuilder()
    .setName("serveraufbau")
    .setDescription("Baut die komplette Byteflix-Serverstruktur (Rollen, Kanäle, Rechte) auf.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
];

export const commands = commandBuilders.map((command) => command.toJSON());
