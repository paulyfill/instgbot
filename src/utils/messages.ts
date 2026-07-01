import TelegramBot from "node-telegram-bot-api";
import { ADMIN_USERNAME, ADMIN_USER_IDS, BOT_TAG } from "../config";
import { safeSendMessage } from "../bot/safe-send";
import { toggleNewsletterSubscription } from "../db/queries";
import { closeDatabase } from "../db/schema";

export const helpMessage = [
  "Отправьте ссылку на медиа или юзернейм телеграм пользователя для скачивания контента.",
  "",
  "Поддерживаемые платформы:",
  "",
  "• Telegram (@username, t.me/user/s/300 — сторис, t.me/channel/300 — пост)",
  "• Instagram (рилсы, посты, сторис)",
  "• Threads (картинки и видео)",
  "• Twitter (X) (посты, картинки и видео)",
  "• Facebook (видео)",
  "• TikTok",
  "• YouTube (Shorts, клипы, полные видео)",
  "",
  "Пример: https://www.instagram.com/reel/DKKPO_gyGAg/?igsh=ejVqOTBpNm85OHA0",
  "",
  "⚡ Лимит: 5 запросов в минуту на медиа контент по ссылке",
  "⚡ Телеграм Сторис лимит: 1 запрос раз в 3 минуты",
  "",
  "📢 /newsletter - управление подпиской на рассылку",
  "💡 /feat [предложение] - предложить новую функцию",
  "",
  BOT_TAG
].join("\n");

export const processNewsletterToggle = async (
  bot: TelegramBot,
  chatId: number,
  username?: string
) => {
  try {
    const isSubscribed = toggleNewsletterSubscription(chatId);

    const message = isSubscribed? [
      "✅ Подписка на рассылку включена!",
      "",
      "Теперь вы будете получать:",
      "• Объявления о новых функциях",
      "• Важные уведомления от бота",
      "",
      "Отключить рассылку: /newsletter"
    ].join("\n"): [
      "❌ Подписка на рассылку отключена.",
      "",
      "Вы больше не будете получать:",
      "• Объявления о новых функциях",
      "• Уведомления от бота",
      "",
      "Включить рассылку: /newsletter"
    ].join("\n");

    await safeSendMessage(bot, chatId, message);
  }
  catch (error) {
    console.error("Newsletter toggle error:", error);
    await safeSendMessage(
      bot,
      chatId,
      "Произошла ошибка при изменении настроек рассылки. Попробуйте позже."
    );
  }
};

export const processFeatureRequest = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  username?: string,
  firstName?: string
) => {
  const featureText = message.replace(/^\/feat\s*/, "").trim();

  if (!featureText) {
    await safeSendMessage(
      bot,
      chatId,
      [
        "💡 Расскажите нам о своей идее!",
        "",
        "Используйте команду так:",
        "/feat добавьте поддержку Pinterest",
        "",
        "Мы рассмотрим ваше предложение и возможно добавим эту функцию в бот! ✨"
      ].join("\n")
    );
    return;
  }

  const userInfo = username ? `@${username}` : firstName || `User ID: ${chatId}`;
  const adminMessage = [
    "💡 Новое предложение функции!",
    "",
    `👤 От пользователя: ${userInfo}`,
    `🆔 Chat ID: ${chatId}`,
    "",
    "📝 Предложение:",
    featureText,
    "",
    `⏰ Время: ${new Date().toLocaleString("ru-RU")}`
  ].join("\n");

  let successCount = 0;
  for (const adminId of ADMIN_USER_IDS) {
    try {
      await safeSendMessage(bot, adminId, adminMessage, {
        disable_notification: true
      });
      successCount++;
    }
    catch (error) {
      console.warn(
        `Failed to send feature request to admin ${adminId}:`,
        error
      );
    }
  }

  if (successCount > 0) {
    await safeSendMessage(
      bot,
      chatId,
      [
        "✅ Спасибо за предложение!",
        "",
        "Ваша идея отправлена разработчикам.",
        "Мы рассмотрим её и, возможно, добавим в будущих обновлениях! 🚀"
      ].join("\n")
    );
  }
  else {
    await safeSendMessage(
      bot,
      chatId,
      [
        "❌ Произошла ошибка при отправке предложения.",
        "Попробуйте позже или обратитесь к администратору.",
        ADMIN_USERNAME
      ].join("\n")
    );
  }
};

export const notifyAdmins = async (bot: TelegramBot, message: string) => {
  for (const adminId of ADMIN_USER_IDS) {
    try {
      await safeSendMessage(bot, adminId, message);
    }
    catch (error) {
      console.warn(`Failed to notify admin ${adminId}:`, error);
    }
  }
};

export const shutdown = async (signal: string, bot: TelegramBot) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  try {
    await bot.stopPolling();
    console.log("Bot stopped polling!");

    closeDatabase();
    console.log("Database closed");

    process.exit(0);
  }
  catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

export const splitMessage = (text: string, maxLength: number = 4096): string[] => {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let currentChunk = "";

  for (const line of text.split("\n")) {
    if (currentChunk.length + line.length + 1 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = line;
      }
      else {
        chunks.push(line.substring(0, maxLength));
        currentChunk = line.substring(maxLength);
      }
    }
    else {
      currentChunk += (currentChunk ? "\n" : "") + line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
};
