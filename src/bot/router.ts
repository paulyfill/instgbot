import type TelegramBot from "node-telegram-bot-api";
import type { TelegramClient } from "telegram";
import { handleAdminCommands } from "../handlers/admin";
import { upsertUser } from "../db/queries";
import { BOT_TAG, isAdmin } from "../config";
import { safeSendMessage } from "./safe-send";
import { sendErrorToAdmin } from "./errors";
import { checkRateLimit, checkTelegramStoriesRateLimit, sendRateLimitMessage } from "./rate-limit";
import { isTelegramLink, isThreadsLink, isYoutubeLink, isYoutubeShortsLink, parseTelegramLink } from "../media/platform";
import { processSocialMedia } from "../handlers/social-media";
import { processThreads } from "../handlers/threads";
import { processYouTubeShorts } from "../handlers/youtube";
import { sendYouTubeQualityPicker } from "../handlers/youtube-full";
import { helpMessage, processFeatureRequest, processNewsletterToggle } from "../utils/messages";
import { downloadPrivateTelegramPost, downloadStories, downloadStoryById, downloadTelegramPost } from "../handlers/telegram";

const START_MESSAGE = [
  "Привет! 👋",
  "",
  "Я бот для скачивания медиа из социальных сетей. ✨",
  "",
  "Я могу:",
  "",
  "• скачивать сторис и посты из Telegram (@username или ссылка t.me/...)",
  "• скачивать рилсы, посты и сторис с Instagram",
  "• скачивать посты, видео и изображения из Twitter (X)",
  "• скачивать посты из Threads (картинки и видео)",
  "• скачивать видео из TikTok",
  "• скачивать видео из Facebook",
  "• скачивать любые видео с YouTube (Shorts, клипы, полные видео)",
  "",
  BOT_TAG
].join("\n");

async function handleTelegramContent (
  bot: TelegramBot,
  userClient: TelegramClient,
  message: string,
  chatId: number,
  userId: number
) {
  const rateLimit = checkTelegramStoriesRateLimit(userId ?? chatId);
  if (!rateLimit.allowed) {
    const minutesLeft = Math.ceil((rateLimit.resetTime - Date.now()) / 60000);
    await safeSendMessage(bot, chatId, `⚡ Лимит: 1 запрос раз в 3 минуты. Попробуйте снова через ${minutesLeft} мин.`);
    return;
  }

  const isTelegramUsername = message.startsWith("@") && /^[\w]{5,32}$/.test(message.slice(1));

  if (isTelegramUsername) {
    await downloadStories({ userClient, bot, username: message.slice(1), chatId });
    return;
  }

  const parsed = parseTelegramLink(message);
  if (!parsed) {
    await safeSendMessage(bot, chatId, "Не удалось распознать ссылку Telegram.");
    return;
  }

  if (parsed.type === "private_post") {
    await downloadPrivateTelegramPost({ userClient, bot, channelId: parsed.channelId, messageId: parsed.messageId, chatId });
  }
  else if (parsed.type === "story") {
    await downloadStoryById({ userClient, bot, username: parsed.username, storyId: parsed.id, chatId });
  }
  else if (parsed.type === "post") {
    await downloadTelegramPost({ userClient, bot, username: parsed.username, postId: parsed.id, chatId });
  }
  else {
    await downloadStories({ userClient, bot, username: parsed.username, chatId });
  }
}

async function handleMediaUrl (
  bot: TelegramBot,
  chatId: number,
  userId: number | undefined,
  message: string,
  username?: string,
  firstName?: string
) {
  upsertUser(chatId, username, firstName);

  if (isAdmin(userId)) {
    const handled = await handleAdminCommands(bot, chatId, message, userId!);
    if (handled) return;
  }

  if (!isAdmin(userId)) {
    const rateLimitCheck = checkRateLimit(chatId);
    if (!rateLimitCheck.allowed) {
      await sendRateLimitMessage(bot, chatId, rateLimitCheck.resetTime);
      return;
    }
  }

  if (isYoutubeShortsLink(message)) {
    await processYouTubeShorts(bot, chatId, message, username, firstName);
  }
  else if (isYoutubeLink(message)) {
    await sendYouTubeQualityPicker(bot, chatId, message, username);
  }
  else if (isThreadsLink(message)) {
    await processThreads(bot, chatId, message, username, firstName);
  }
  else {
    await processSocialMedia(bot, chatId, message, username, firstName);
  }
}

export function registerMessageHandlers (bot: TelegramBot, userClient: TelegramClient) {
  bot.onText(/\/start/, async (msg) => {
    await safeSendMessage(bot, msg.chat.id, START_MESSAGE);
  });

  bot.onText(/(.+)/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const username = msg.from?.username;
    const firstName = msg.from?.first_name;
    const message = msg.text!;

    if (message === "/start") return;

    if (message === "/help") {
      await safeSendMessage(bot, chatId, helpMessage);
      return;
    }

    if (message === "/newsletter") {
      await processNewsletterToggle(bot, chatId, username);
      return;
    }

    if (message.startsWith("/feat")) {
      await processFeatureRequest(bot, chatId, message, username, firstName);
      return;
    }

    const isValidUrl = message.includes("https://") || message.includes("http://");
    const isAdminCommand = isAdmin(userId) && message.startsWith("/");
    const isTelegramUsername = message.startsWith("@") && /^[\w]{5,32}$/.test(message.slice(1));

    if (!isValidUrl && !isAdminCommand && !isTelegramUsername) {
      await safeSendMessage(bot, chatId, helpMessage);
      return;
    }

    const isTelegramContent = isTelegramUsername || (isValidUrl && isTelegramLink(message));

    if (isTelegramContent) {
      try {
        await handleTelegramContent(bot, userClient, message, chatId, userId ?? chatId);
      }
      catch (e) {
        await safeSendMessage(bot, chatId, "Не удалось загрузить контент.");
        console.error(e);
      }
      return;
    }

    try {
      await handleMediaUrl(bot, chatId, userId, message, username, firstName);
    }
    catch (error: any) {
      const errorMessage = error?.message || String(error);
      if (
        errorMessage.includes("bot was blocked by the user") ||
        errorMessage.includes("user is deactivated") ||
        errorMessage.includes("chat not found") ||
        errorMessage.includes("ETELEGRAM: 403 Forbidden")
      ) return;

      await sendErrorToAdmin(bot, error, "main function", message, chatId, username);
    }
  });
}
