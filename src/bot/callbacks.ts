import type TelegramBot from "node-telegram-bot-api";
import { handleYouTubeCallback } from "../handlers/youtube-full";

export function registerCallbackHandlers (bot: TelegramBot) {
  bot.on("callback_query", async (query) => {
    const data = query.data ?? "";
    const chatId = query.message?.chat.id;
    if (!chatId) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const ytMatch = data.match(/^yt:(\d+):(v|a):(\d+)$/);
    if (ytMatch) {
      const originChatId = Number(ytMatch[1]);
      if (originChatId !== chatId) return;
      const type = ytMatch[2] as "v" | "a";
      const quality = Number(ytMatch[3]);
      await handleYouTubeCallback(bot, chatId, type, quality, query.from.id, query.from.username);
    }
  });
}
