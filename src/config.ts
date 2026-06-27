import { z } from "zod";

function optionalNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN fehlt"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh"]).default("low"),
  OPENAI_MAX_OUTPUT_TOKENS: z.preprocess((value) => optionalNumber(value, 450), z.number().int().positive()),
  DISCORD_GUILD_ID: z.string().default(""),
  DISCORD_LOG_CHANNEL_ID: z.string().default(""),
  DISCORD_MEMBER_ROLE_ID: z.string().default(""),
  DISCORD_SUPPORT_ROLE_ID: z.string().default(""),
  DISCORD_ADMIN_ROLE_ID: z.string().default(""),
  DISCORD_NEW_ACCOUNT_REVIEW_ROLE_ID: z.string().default(""),
  DISCORD_TICKET_ENTRY_CHANNEL_ID: z.string().default(""),
  DISCORD_TICKET_CATEGORY_ID: z.string().default(""),
  DISCORD_TICKET_LOG_CHANNEL_ID: z.string().default(""),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  API_PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),
  JELLYFIN_BASE_URL: z.string().default(""),
  JELLYFIN_API_KEY: z.string().default(""),
  BOT_DATA_DIR: z.string().default("./data"),
  AUTO_REGISTER_COMMANDS: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_MEMBER_MONITORING: z.preprocess((value) => boolFromEnv(value, false), z.boolean()),
  ENABLE_MESSAGE_QA: z.preprocess((value) => boolFromEnv(value, false), z.boolean()),
  ENABLE_AI_ASSISTANT: z.preprocess((value) => boolFromEnv(value, false), z.boolean()),
  ENABLE_SUPPORT_MESSAGE_TICKETS: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_SUPPORT_MESSAGE_CONTENT: z.preprocess((value) => boolFromEnv(value, false), z.boolean()),
  ENABLE_MODERATION_CONTENT: z.preprocess((value) => boolFromEnv(value, false), z.boolean()),
  ENABLE_ADVANCED_ANTI_SPAM: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_INVITE_LINK_PROTECTION: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_SCAM_PHRASE_PROTECTION: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_NEW_ACCOUNT_PROTECTION: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  ENABLE_TICKET_FOLLOWUPS: z.preprocess((value) => boolFromEnv(value, true), z.boolean()),
  MAX_MESSAGES_PER_MINUTE: z.preprocess((value) => optionalNumber(value, 14), z.number().int().positive()),
  WARNINGS_BEFORE_TIMEOUT: z.preprocess((value) => optionalNumber(value, 3), z.number().int().positive()),
  TIMEOUT_MINUTES: z.preprocess((value) => optionalNumber(value, 10), z.number().int().positive()),
  NEW_ACCOUNT_WARN_DAYS: z.preprocess((value) => optionalNumber(value, 7), z.number().int().positive()),
  NEW_ACCOUNT_STRICT_DAYS: z.preprocess((value) => optionalNumber(value, 2), z.number().int().positive()),
  NEW_ACCOUNT_STRICT_TIMEOUT_MINUTES: z.preprocess((value) => optionalNumber(value, 0), z.number().int().nonnegative()),
  TICKET_FOLLOWUP_HOURS: z.preprocess((value) => optionalNumber(value, 24), z.number().int().positive()),
  TICKET_FOLLOWUP_CHECK_MINUTES: z.preprocess((value) => optionalNumber(value, 30), z.number().int().positive()),
  MAX_OPEN_TICKETS_PER_USER: z.preprocess((value) => optionalNumber(value, 1), z.number().int().positive()),
  STATS_REFRESH_MINUTES: z.preprocess((value) => optionalNumber(value, 15), z.number().int().positive())
});

export const config = schema.parse(process.env);
