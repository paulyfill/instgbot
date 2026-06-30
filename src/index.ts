import TelegramBot from "node-telegram-bot-api";
import { handleAdminCommands } from "./admin";
import { upsertUser } from "./database";
import {
  BOT_TAG,
  checkRateLimit,
  checkTelegramStoriesRateLimit,
  helpMessage,
  isAdmin,
  isTelegramLink,
  isThreadsLink,
  isYoutubeLink,
  isYoutubeShortsLink,
  notifyAdmins,
  parseTelegramLink,
  processFeatureRequest,
  processNewsletterToggle,
  processSocialMedia,
  processThreads,
  processYouTubeShorts,
  safeSendMessage,
  sendErrorToAdmin,
  sendRateLimitMessage,
  shutdown
} from "./utils";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
// @ts-ignore - no types available
import input from "input";
import { downloadStories, downloadStoryById, downloadTelegramPost, downloadPrivateTelegramPost } from "./telegramStories";

const token = Bun.env.TELEGRAM_BOT!;
Bun.env.NTBA_FIX_350 = "1";
const bot = new TelegramBot(token, { polling: true });

const apiId = +Bun.env.TELEGRAM_API_ID!;
const apiHash = Bun.env.TELEGRAM_API_HASH!;
const stringSession = new StringSession(Bun.env.TELEGRAM_STRING_SESSION!); // first run empty

const userClient = new TelegramClient(
  stringSession,
  apiId,
  apiHash,
  { connectionRetries: 5 }
);

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await safeSendMessage(
    bot,
    chatId,
    [
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
      "• скачивать видео из TikTok ",
      "• скачивать видео из Facebook",
      "• скачивать YouTube Shorts",
      "",
      BOT_TAG
    ].join("\n")
  );
  return;
});

bot.onText(/(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const username = msg.from?.username;
  const firstName = msg.from?.first_name;
  const message = msg.text!;

  if (message && message === "/start") {
    return;
  }

  if (message && message === "/help") {
    await safeSendMessage(bot, chatId, helpMessage);
    return;
  }

  if (message && message === "/newsletter") {
    await processNewsletterToggle(bot, chatId, username);
    return;
  }

  if (message && message.startsWith("/feat")) {
    await processFeatureRequest(bot, chatId, message, username, firstName);
    return;
  }

  const isValidUrl =
    message &&
    (message.includes("https://") || message.includes("http://")) &&
    message.trim() !== "" &&
    message.trim().length >= 10;

  const isAdminCommand = isAdmin(userId) && message && message.startsWith("/");

  const isTelegramUsername =
    message &&
    message.startsWith("@") &&
    /^[\w]{5,32}$/.test(message.slice(1));

  if (!isValidUrl && !isAdminCommand && !isTelegramUsername) {
    await safeSendMessage(bot, chatId, helpMessage);
    return;
  }

  const isTelegramUrl = isValidUrl && isTelegramLink(message);

  if (isTelegramUsername || isTelegramUrl) {
    const rateLimit = checkTelegramStoriesRateLimit(userId ?? chatId);
    if (!rateLimit.allowed) {
      const minutesLeft = Math.ceil((rateLimit.resetTime - Date.now()) / 60000);
      await safeSendMessage(
        bot,
        chatId,
        `⚡ Лимит: 1 запрос раз в 3 минуты. Попробуйте снова через ${minutesLeft} мин.`
      );
      return;
    }
    try {
      if (isTelegramUsername) {
        await downloadStories({ userClient, bot, username: message.slice(1), chatId });
      } else {
        const parsed = parseTelegramLink(message);
        if (!parsed) {
          await safeSendMessage(bot, chatId, "Не удалось распознать ссылку Telegram.");
          return;
        }
        if (parsed.type === "private_post") {
          await downloadPrivateTelegramPost({ userClient, bot, channelId: parsed.channelId, messageId: parsed.messageId, chatId });
        } else if (parsed.type === "story") {
          await downloadStoryById({ userClient, bot, username: parsed.username, storyId: parsed.id, chatId });
        } else if (parsed.type === "post") {
          await downloadTelegramPost({ userClient, bot, username: parsed.username, postId: parsed.id, chatId });
        } else {
          await downloadStories({ userClient, bot, username: parsed.username, chatId });
        }
      }
    }
    catch (e) {
      await safeSendMessage(bot, chatId, "Не удалось загрузить контент.");
      console.error(e);
    }
    return;
  }

  try {
    upsertUser(chatId, username, firstName);

    if (isAdmin(userId)) {
      const handled = await handleAdminCommands(bot, chatId, message, userId);
      if (handled) return;
    }

    // 🚦 Проверяем rate limiting для обычных пользователей
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
      await safeSendMessage(bot, chatId, `Поддерживаются только YouTube Shorts.\nОбычные YouTube видео скачать нельзя.\n\n${BOT_TAG}`);
    }
    else if (isThreadsLink(message)) {
      await processThreads(bot, chatId, message, username, firstName);
    }
    else {
      await processSocialMedia(bot, chatId, message, username, firstName);
    }
  }
  catch (error: any) {
    const errorMessage =
      error && typeof error === "object"? error.message || String(error): String(error);

    if (
      errorMessage.includes("bot was blocked by the user") ||
      errorMessage.includes("user is deactivated") ||
      errorMessage.includes("chat not found") ||
      errorMessage.includes("ETELEGRAM: 403 Forbidden")
    ) {
      return;
    }

    await sendErrorToAdmin(
      bot,
      error,
      "main function",
      message,
      chatId,
      username
    );
  }
});

(async () => {
  await userClient.start({
    phoneNumber: () => input.text("Phone number: "),
    password: () => input.text("2FA password (if any): "),
    phoneCode: () => input.text("Code: "),
    onError: console.log
  });

  userClient.session.save();
})();

process.on("SIGINT", async () => {
  await notifyAdmins(bot, "Bot is shutting down due to SIGINT signal");
  shutdown("SIGINT", bot);
});
process.on("SIGTERM", async () => {
  await notifyAdmins(bot, "Bot is shutting down due to SIGTERM signal");
  shutdown("SIGTERM", bot);
});

console.log("Bot started successfully!");

export default bot;
