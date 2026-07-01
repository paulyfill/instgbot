import TelegramBot from "node-telegram-bot-api";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

Bun.env.NTBA_FIX_350 = "1";

export const bot = new TelegramBot(Bun.env.TELEGRAM_BOT!, { polling: true });

export const userClient = new TelegramClient(
  new StringSession(Bun.env.TELEGRAM_STRING_SESSION!),
  +Bun.env.TELEGRAM_API_ID!,
  Bun.env.TELEGRAM_API_HASH!,
  { connectionRetries: 5 }
);
