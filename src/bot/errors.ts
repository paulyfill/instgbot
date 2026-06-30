import TelegramBot from "node-telegram-bot-api";
import { ADMIN_USER_IDS } from "../config";
import { safeSendMessage } from "./safe-send";

export class FileTooLargeError extends Error {
  constructor (size: number) {
    super(`File too large: ${Math.round(size / 1024 / 1024)}MB (limit: 50MB)`);
    this.name = "FileTooLargeError";
  }
}

export class MediaFetchError extends Error {
  constructor (reason: string) {
    super(reason);
    this.name = "MediaFetchError";
  }
}

export const sendErrorToAdmin = async (
  bot: TelegramBot,
  error: any,
  context: string,
  userMessage?: string,
  chatId?: number,
  username?: string
) => {
  if (error && typeof error === "object") {
    const errorMessage = error.message || String(error);

    if (
      errorMessage.includes("bot was blocked by the user") ||
      errorMessage.includes("user is deactivated") ||
      errorMessage.includes("chat not found") ||
      errorMessage.includes("ETELEGRAM: 403 Forbidden") ||
      errorMessage.includes("413 Request Entity Too Large")
    ) {
      return;
    }

    if (error instanceof FileTooLargeError || error instanceof MediaFetchError) {
      return;
    }
  }
  const contextMessages: { [key: string]: string } = {
    "youtube download": "🎥 Ошибка загрузки YouTube Shorts",
    "youtube video send": "📤 Ошибка отправки YouTube видео",
    "youtube mp4 check": "🔍 YouTube не вернул ссылку на видео",
    "snapsave download": "📱 Ошибка скачивания из соцсетей",
    "media check": "📁 Не найдены медиафайлы в ответе",
    "single video": "🎬 Ошибка обработки одного видео",
    "single photo": "📸 Ошибка обработки одного фото",
    "sendMediaGroup videos": "🎥📦 Ошибка отправки группы видео",
    "sendMediaGroup photos": "📸📦 Ошибка отправки группы фото",
    "tweet to image": "🐦 Ошибка конвертации твита в изображение",
    "delete loading message": "🗑️ Не удалось удалить сообщение 'Загружаю...'",
    "main message handler": "⚙️ Общая ошибка обработки сообщения",
    "main function": "🚨 Критическая ошибка бота"
  };

  const contextTitle = contextMessages[context] || `❌ Ошибка: ${context}`;

  let errorDetails = "";
  if (typeof error === "object" && error !== null) {
    if (error.message) {
      errorDetails = error.message;
    }
    else if (error.error) {
      errorDetails = JSON.stringify(error.error, null, 2);
    }
    else {
      errorDetails = JSON.stringify(error, null, 2);
    }
  }
  else {
    errorDetails = String(error);
  }

  const userInfo = chatId? `🚨 У пользователя ${
    username ? `@${username}` : `ID: ${chatId}`
  } произошла ошибка${userMessage ? ` при сообщении "${userMessage}"` : ""}`: "🚨 Системная ошибка бота";

  const errorMessage = [
    userInfo,
    "",
    contextTitle,
    "",
    "🔍 Детали ошибки:",
    errorDetails,
    "",
    ...(chatId ? [`👤 Chat ID: ${chatId}`, ""] : []),
    `⏰ Время: ${new Date().toLocaleString("ru-RU")}`
  ].join("\n");

  for (const adminId of ADMIN_USER_IDS) {
    try {
      await safeSendMessage(bot, adminId, errorMessage, {
        disable_notification: true
      });
    }
    catch (e) {
      console.warn(`Failed to send error to admin ${adminId}:`, e);
    }
  }
};
