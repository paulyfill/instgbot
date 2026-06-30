import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { youtube } from "btch-downloader";
import {
  closeDatabase,
  detectPlatform,
  recordDownload,
  recordError,
  toggleNewsletterSubscription
} from "./database";

type ThreadsApiResponse = {
  image_urls: string[];
  video_urls: { download_url: string }[];
};

type UserRateLimit = {
  requests: number[];
  lastCleanup: number;
};

type RateLimitResult = {
  allowed: boolean;
  remainingRequests: number;
  resetTime: number;
};

const userRateLimits = new Map<number, UserRateLimit>();
const RATE_LIMIT_REQUESTS = 5; // Максимум запросов
const RATE_LIMIT_WINDOW = 60 * 1000; // Окно в 1 минуту (мс)

// Функция проверки rate limit
export const checkRateLimit = (userId: number): RateLimitResult => {
  const now = Date.now();

  // Получаем или создаем данные пользователя
  let userLimit = userRateLimits.get(userId);
  if (!userLimit) {
    userLimit = { requests: [], lastCleanup: now };
    userRateLimits.set(userId, userLimit);
  }

  // Очищаем старые запросы (старше 1 минуты)
  userLimit.requests = userLimit.requests.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW
  );

  if (userLimit.requests.length >= RATE_LIMIT_REQUESTS) {
    const oldestRequest = Math.min(...userLimit.requests);
    const resetTime = oldestRequest + RATE_LIMIT_WINDOW;
    return {
      allowed: false,
      remainingRequests: 0,
      resetTime
    };
  }

  userLimit.requests.push(now);

  return {
    allowed: true,
    remainingRequests: RATE_LIMIT_REQUESTS - userLimit.requests.length,
    resetTime: now + RATE_LIMIT_WINDOW
  };
};

const tgStoriesRateLimits = new Map<number, number>(); // userId -> timestamp последнего запроса
const TG_STORIES_LIMIT_WINDOW = 3 * 60 * 1000; // 3 минуты

export const checkTelegramStoriesRateLimit = (userId: number): { allowed: boolean, resetTime: number } => {
  if (isAdmin(userId)) return { allowed: true, resetTime: 0 };
  const now = Date.now();
  const lastRequest = tgStoriesRateLimits.get(userId) || 0;
  if (now - lastRequest < TG_STORIES_LIMIT_WINDOW) {
    return {
      allowed: false,
      resetTime: lastRequest + TG_STORIES_LIMIT_WINDOW
    };
  }
  tgStoriesRateLimits.set(userId, now);
  return { allowed: true, resetTime: now + TG_STORIES_LIMIT_WINDOW };
};

export const cleanupRateLimitData = () => {
  const now = Date.now();
  for (const [userId, userLimit] of userRateLimits.entries()) {
    if (now - userLimit.lastCleanup > 5 * 60 * 1000) {
      userRateLimits.delete(userId);
    }
  }
};

export const cleanupTelegramStoriesRateLimit = () => {
  const now = Date.now();
  for (const [userId, lastRequest] of tgStoriesRateLimits.entries()) {
    if (now - lastRequest > TG_STORIES_LIMIT_WINDOW) {
      tgStoriesRateLimits.delete(userId);
    }
  }
};
setInterval(() => {
  cleanupTelegramStoriesRateLimit();
  cleanupRateLimitData();
}, 5 * 60 * 1000);

export const BOT_TAG = "@instg_save_bot";
export const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME!;
export const ADMIN_USER_IDS = [324025710, 542142955];

export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return ADMIN_USER_IDS.includes(userId);
};

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

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const isBotBlockedError = (error: any): boolean => {
  const msg: string = error && typeof error === "object" ? error.message || String(error) : String(error);
  return (
    msg.includes("bot was blocked by the user") ||
    msg.includes("user is deactivated") ||
    msg.includes("chat not found") ||
    msg.includes("ETELEGRAM: 403 Forbidden")
  );
};

export const safeSendMessage = async (
  bot: TelegramBot,
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeSendVideo = async (
  bot: TelegramBot,
  chatId: number,
  video: string | Buffer,
  options?: TelegramBot.SendVideoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendVideo(chatId, video, options);
  } catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeSendPhoto = async (
  bot: TelegramBot,
  chatId: number,
  photo: string | Buffer,
  options?: TelegramBot.SendPhotoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  } catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeSendMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  media: TelegramBot.InputMedia[],
  options?: TelegramBot.SendMediaGroupOptions
): Promise<TelegramBot.Message[] | null> => {
  try {
    return await bot.sendMediaGroup(chatId, media, options);
  } catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeDeleteMessage = async (
  bot: TelegramBot,
  chatId: number,
  messageId: number
): Promise<boolean> => {
  try {
    return await bot.deleteMessage(chatId, messageId);
  } catch (error: any) {
    return false;
  }
};

const fetchWithTimeout = (url: string, timeoutMs = 30_000, options?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const downloadBuffer = async (url: string): Promise<Buffer> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  } catch (e: any) {
    const msg: string = e?.message || String(e);
    if (msg.includes("redirected too many times") || msg.includes("redirect")) {
      throw new MediaFetchError("Ссылка содержит слишком много перенаправлений.");
    }
    if (e?.name === "AbortError") {
      throw new MediaFetchError("Превышено время ожидания загрузки файла.");
    }
    throw e;
  }

  if (!response.ok) {
    throw new MediaFetchError(`Сервер вернул ошибку ${response.status}.`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
    throw new FileTooLargeError(parseInt(contentLength));
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FILE_SIZE) {
    throw new FileTooLargeError(arrayBuffer.byteLength);
  }

  return Buffer.from(arrayBuffer);
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
      } else {
        chunks.push(line.substring(0, maxLength));
        currentChunk = line.substring(maxLength);
      }
    } else {
      currentChunk += (currentChunk ? "\n" : "") + line;
    }
  }

  if (currentChunk) chunks.push(currentChunk);
  return chunks;
};

export const isYoutubeShortsLink = (url: string): boolean => {
  return url.includes("youtube.com/shorts/");
};

export const isYoutubeLink = (url: string): boolean => {
  return url.includes("youtube.com/") || url.includes("youtu.be/");
};

export type TelegramLinkInfo =
  | { type: "story"; username: string; id: number }
  | { type: "post"; username: string; id: number }
  | { type: "private_post"; channelId: bigint; messageId: number }
  | { type: "stories_all"; username: string };

export const parseTelegramLink = (url: string): TelegramLinkInfo | null => {
  // https://t.me/c/1724666497/5083 — приватный канал
  const privateMatch = url.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (privateMatch) return { type: "private_post", channelId: BigInt(`-100${privateMatch[1]}`), messageId: +privateMatch[2] };

  // https://t.me/username/s/300 — конкретная сторис
  const storyMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/s\/(\d+)/);
  if (storyMatch) return { type: "story", username: storyMatch[1], id: +storyMatch[2] };

  // https://t.me/username/300 — пост в канале
  const postMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/(\d+)/);
  if (postMatch) return { type: "post", username: postMatch[1], id: +postMatch[2] };

  // https://t.me/username — все сторис
  const usernameMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/?$/);
  if (usernameMatch) return { type: "stories_all", username: usernameMatch[1] };

  return null;
};

export const isTelegramLink = (url: string): boolean => {
  return /https?:\/\/t\.me\/[A-Za-z0-9_]/.test(url);
};

export const isThreadsLink = (url: string): boolean => {
  return url.includes("threads.com");
};

export const sendErrorToAdmin = async (
  bot: TelegramBot,
  error: any,
  context: string,
  userMessage?: string,
  chatId?: number,
  username?: string
) => {
  if (chatId) {
    try {
      const errorMessage =
        typeof error === "object" && error !== null? error.message || JSON.stringify(error): String(error);
      recordError(chatId, context, errorMessage, userMessage, username);
    }
    catch (dbError) {
      console.error("Failed to record error in database:", dbError);
    }
  }

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

export const processSingleMedia = async (
  bot: TelegramBot,
  chatId: number,
  item: { url?: string },
  type: "video" | "photo",
  username?: string,
): Promise<boolean> => {
  if (!item.url) {
    const sent = await safeSendMessage(bot, chatId, `Не удалось получить URL ${type === "video" ? "видео" : "фото"}.`);
    if (sent !== null) await sendErrorToAdmin(bot, `No ${type} URL`, `single ${type}`, undefined, chatId, username);
    return false;
  }

  try {
    const buffer = await downloadBuffer(item.url);
    if (type === "video") {
      await safeSendVideo(bot, chatId, buffer, { caption: BOT_TAG, disable_notification: true });
    } else {
      await safeSendPhoto(bot, chatId, buffer, { caption: BOT_TAG, disable_notification: true });
    }
    return true;
  } catch (error: any) {
    if (error instanceof FileTooLargeError) {
      await safeSendMessage(bot, chatId, "Слишком большой файл для загрузки. Максимальный размер: 50MB.");
      return true;
    }
    if (error instanceof MediaFetchError) {
      await safeSendMessage(bot, chatId, `Не удалось загрузить файл: ${error.message}`);
      return false;
    }
    if (isBotBlockedError(error)) return false;
    await sendErrorToAdmin(bot, error, `single ${type}`, undefined, chatId, username);
    return false;
  }
};

// ponytail: kept for backwards compat, delegate to processSingleMedia
export const processSingleVideo = (bot: TelegramBot, chatId: number, video: { url?: string }, username?: string) =>
  processSingleMedia(bot, chatId, video, "video", username);

export const processSinglePhoto = (bot: TelegramBot, chatId: number, photo: { url?: string }, username?: string) =>
  processSingleMedia(bot, chatId, photo, "photo", username);

export const processMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  mediaItems: any[],
  mediaType: "video" | "photo",
  username?: string,
  loadingMsg?: TelegramBot.Message
): Promise<boolean> => {
  const validMedia = mediaItems.filter(
    (item) =>
      item.url !== undefined && (item.type === "video" || item.type === "image")
  );
  if (validMedia.length === 0) return false;

  const groupSize = mediaType === "video" ? 3 : 10;
  const mediaGroups: (typeof validMedia)[] = [];
  for (let i = 0; i < validMedia.length; i += groupSize) {
    mediaGroups.push(validMedia.slice(i, i + groupSize));
  }

  for (let groupIndex = 0; groupIndex < mediaGroups.length; groupIndex++) {
    const group = mediaGroups[groupIndex];

    let mediaBuffers: { buffer: Buffer, index: number }[] = [];
    try {
      const downloadResults = await Promise.all(group.map(async (item, index) => {
        try {
          const buffer = await downloadBuffer(item.url);
          return { buffer, index, success: true };
        } catch (error) {
          console.error(`Failed to download item ${index}:`, error);
          return { buffer: null, index, success: false, error };
        }
      }));

      mediaBuffers = downloadResults.filter(
        (result) => result.success && result.buffer
      ) as { buffer: Buffer, index: number }[];

      if (mediaBuffers.length === 0) {
        console.log("No media files were downloaded successfully");
        continue;
      }

      // Проверяем общий размер
      let totalSize = 0;
      for (const { buffer } of mediaBuffers) {
        totalSize += buffer.length;
      }

      const maxGroupSize = 40 * 1024 * 1024; // 40MB
      if (totalSize > maxGroupSize) {
        console.log(
          `Group size ${Math.round(
            totalSize / 1024 / 1024
          )}MB exceeds limit, sending individually`
        );

        for (const { buffer, index } of mediaBuffers) {
          if (mediaType === "video") {
            await safeSendVideo(bot, chatId, buffer, {
              caption: index === 0 ? BOT_TAG : undefined,
              disable_notification: true
            });
          }
          else {
            await safeSendPhoto(bot, chatId, buffer, {
              caption: index === 0 ? BOT_TAG : undefined,
              disable_notification: true
            });
          }

          if (index < mediaBuffers.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      }
      else {
        const telegramMedia = mediaBuffers.map(({ buffer, index }) => ({
          type: mediaType,
          media: buffer as any,
          caption: index === 0 ? BOT_TAG : undefined
        }));

        await safeSendMediaGroup(bot, chatId, telegramMedia, {
          disable_notification: true
        });
      }

      if (groupIndex < mediaGroups.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    catch (error: any) {
      if (error instanceof FileTooLargeError) {
        await safeSendMessage(bot, chatId, "Один или несколько файлов слишком большие для загрузки. Максимальный размер: 50MB.");
        return true;
      }

      if (error instanceof MediaFetchError) {
        await safeSendMessage(bot, chatId, `Не удалось загрузить файл: ${error.message}`);
        return false;
      }

      const errorMessage = error.message || String(error);

      if (errorMessage.includes("413 Request Entity Too Large")) {
        for (let i = 0; i < mediaBuffers.length; i++) {
          const { buffer } = mediaBuffers[i];
          try {
            if (mediaType === "video") {
              await safeSendVideo(bot, chatId, buffer, { caption: i === 0 ? BOT_TAG : undefined, disable_notification: true });
            } else {
              await safeSendPhoto(bot, chatId, buffer, { caption: i === 0 ? BOT_TAG : undefined, disable_notification: true });
            }
            if (i < mediaBuffers.length - 1) await new Promise(r => setTimeout(r, 200));
          } catch (e: any) {
            console.error(`Failed to send individual ${mediaType} ${i}:`, e);
          }
        }
        continue;
      }

      if (isBotBlockedError(error)) return false;

      await sendErrorToAdmin(
        bot,
        error,
        `sendMediaGroup ${mediaType}s`,
        undefined,
        chatId,
        username
      );
      return false;
    }
  }

  return true;
};

const getThreadsDownloadLinks = async (url: string): Promise<ThreadsApiResponse> => {
  const response = await fetchWithTimeout(`https://api.threadsphotodownloader.com/v2/media?url=${encodeURIComponent(url)}`, 15_000);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  // Приводим video_urls к нужному формату, если вдруг API вернет массив строк
  let video_urls: { download_url: string }[] = [];
  if (Array.isArray(data.video_urls)) {
    if (data.video_urls.length > 0 && typeof data.video_urls[0] === "string") {
      video_urls = data.video_urls.map((url: string) => ({ download_url: url }));
    }
    else {
      video_urls = data.video_urls;
    }
  }
  return {
    image_urls: data.image_urls || [],
    video_urls
  };
};

export const processThreads = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  username?: string,
  firstName?: string
) => {
  const platform = detectPlatform(message);

  let loadingMsg: TelegramBot.Message | null = null;
  let hasSuccessfulDownload = false;
  try {
    const response = await getThreadsDownloadLinks(message);
    const photos: string[] = response.image_urls || [];
    const videos: string[] = (response.video_urls || []).map(v => v.download_url);

    if (photos.length === 0 && videos.length === 0) {
      await safeSendMessage(
        bot,
        chatId,
        "Не удалось получить медиафайлы из Threads."
      );
      recordDownload(
        chatId,
        message,
        platform,
        "unknown",
        false,
        username,
        firstName
      );
      return;
    }

    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
      disable_notification: true
    });
    if (loadingMsg === null) {
      recordDownload(
        chatId,
        message,
        platform,
        "unknown",
        false,
        username,
        firstName
      );
      return;
    }

    if (photos.length === 1) {
      hasSuccessfulDownload = await processSinglePhoto(bot, chatId, { url: photos[0] }, username) || hasSuccessfulDownload;
    }
    else if (photos.length > 1) {
      const photoItems = photos.map((url) => ({ type: "image", url }));
      hasSuccessfulDownload = await processMediaGroup(bot, chatId, photoItems, "photo", username) || hasSuccessfulDownload;
    }

    if (videos.length === 1) {
      hasSuccessfulDownload = await processSingleVideo(bot, chatId, { url: videos[0] }, username) || hasSuccessfulDownload;
    }
    else if (videos.length > 1) {
      const videoItems = videos.map((url) => ({ type: "video", url }));
      hasSuccessfulDownload = await processMediaGroup(bot, chatId, videoItems, "video", username) || hasSuccessfulDownload;
    }

    if (loadingMsg) {
      await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    }

    recordDownload(
      chatId,
      message,
      platform,
      photos.length > 0 ? "photo" : "video",
      hasSuccessfulDownload,
      username,
      firstName
    );
  }
  catch (error) {
    if (loadingMsg) {
      await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    }
    await safeSendMessage(
      bot,
      chatId,
      "Не удалось скачать медиа с Threads. Попробуйте еще раз."
    );
    await sendErrorToAdmin(
      bot,
      error,
      "threads download",
      message,
      chatId,
      username
    );
    recordDownload(
      chatId,
      message,
      platform,
      "unknown",
      false,
      username,
      firstName
    );
  }
};

export const processYouTubeShorts = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  username?: string,
  firstName?: string
) => {
  const platform = detectPlatform(message);

  try {
    const response = await youtube(message);

    if (response && response.mp4) {
      const loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
        disable_notification: true
      });

      if (loadingMsg === null) {
        return;
      }

      try {
        const videoBuffer = await downloadBuffer(response.mp4);

        await safeSendVideo(bot, chatId, videoBuffer, {
          caption: BOT_TAG,
          disable_notification: true
        });

        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);

        recordDownload(
          chatId,
          message,
          platform,
          "video",
          true,
          username,
          firstName
        );
      }
      catch (sendError: any) {
        if (sendError instanceof FileTooLargeError) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
          await safeSendMessage(
            bot,
            chatId,
            "Видео слишком большое для загрузки. Максимальный размер: 50MB."
          );
          recordDownload(
            chatId,
            message,
            platform,
            "video",
            false,
            username,
            firstName
          );
          return;
        }

        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        await safeSendMessage(
          bot,
          chatId,
          "Не удалось отправить видео с YouTube Shorts."
        );
        await sendErrorToAdmin(
          bot,
          sendError,
          "youtube video send",
          message,
          chatId,
          username
        );
        recordDownload(
          chatId,
          message,
          platform,
          "video",
          false,
          username,
          firstName
        );
      }
    }
    else {
      await safeSendMessage(
        bot,
        chatId,
        "Не удалось получить видео с YouTube Shorts."
      );
      await sendErrorToAdmin(
        bot,
        "No mp4 URL in YouTube response",
        "youtube mp4 check",
        message,
        chatId,
        username
      );
      recordDownload(
        chatId,
        message,
        platform,
        "video",
        false,
        username,
        firstName
      );
    }
  }
  catch (error) {
    await safeSendMessage(
      bot,
      chatId,
      "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз."
    );
    await sendErrorToAdmin(
      bot,
      error,
      "youtube download",
      message,
      chatId,
      username
    );
    recordDownload(
      chatId,
      message,
      platform,
      "video",
      false,
      username,
      firstName
    );
  }
};

const handleUnderlineEnding = (text: string): string => {
  if (text.endsWith("_")) {
    return text + "/";
  }
  return text;
};

const convertTweetToImage = async (
  tweetUrl: string
): Promise<Buffer | null> => {
  try {
    const tweetId = tweetUrl.split("/").pop()?.split("?")[0];
    if (!tweetId) {
      throw new Error("Could not extract tweet ID from URL");
    }

    const response = await fetchWithTimeout(
      `https://twtoimage.vercel.app/api/tweet-to-image/${tweetId}`,
      15_000
    );
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  catch (error) {
    console.error("Tweet to image conversion error:", error);
    return null;
  }
};

export const processSocialMedia = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  username?: string,
  firstName?: string
) => {
  const platform = detectPlatform(message);

  try {
    const formattedMessage = handleUnderlineEnding(message);
    const download = await snapsave(formattedMessage, {
      retry: 3,
      retryDelay: 500,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
    });

    if (!download.success) {
      // Если это Twitter/X и snapsave не сработал, пробуем конвертировать в изображение
      if (platform === "twitter" || platform === "x") {
        const loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
          disable_notification: true
        });

        if (loadingMsg === null) {
          return;
        }

        try {
          const imageBuffer = await convertTweetToImage(message);

          if (imageBuffer) {
            await safeSendPhoto(bot, chatId, imageBuffer, {
              caption: BOT_TAG,
              disable_notification: true
            });

            await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
            recordDownload(
              chatId,
              message,
              platform,
              "image",
              true,
              username,
              firstName
            );
            return;
          }
          else {
            await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
            await safeSendMessage(
              bot,
              chatId,
              "Не удалось конвертировать твит в изображение."
            );
            await sendErrorToAdmin(
              bot,
              "Tweet to image conversion failed",
              "tweet to image",
              message,
              chatId,
              username
            );
            recordDownload(
              chatId,
              message,
              platform,
              "image",
              false,
              username,
              firstName
            );
            return;
          }
        }
        catch (error: any) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
          await safeSendMessage(
            bot,
            chatId,
            "Ошибка при конвертации твита в изображение."
          );
          await sendErrorToAdmin(
            bot,
            error,
            "tweet to image",
            message,
            chatId,
            username
          );
          recordDownload(
            chatId,
            message,
            platform,
            "image",
            false,
            username,
            firstName
          );
          return;
        }
      }

      await safeSendMessage(
        bot,
        chatId,
        `Не удалось скачать медиафайл.\nУбедитесь, что медиафайл существует и не является приватным.\nЕсли ошибка возникает многократно, пишите ${ADMIN_USERNAME}`
      );
      await sendErrorToAdmin(
        bot,
        download,
        "snapsave download",
        message,
        chatId,
        username
      );
      recordDownload(
        chatId,
        message,
        platform,
        "unknown",
        false,
        username,
        firstName
      );
      return;
    }

    const media = download.data?.media;
    if (!media) {
      await safeSendMessage(
        bot,
        chatId,
        "Не удалось скачать медиа. Попробуйте еще раз."
      );
      await sendErrorToAdmin(
        bot,
        "No media in response",
        "media check",
        message,
        chatId,
        username
      );
      recordDownload(
        chatId,
        message,
        platform,
        "unknown",
        false,
        username,
        firstName
      );
      return;
    }

    const videos = media.filter((m) => m.type === "video");
    const photos = media.filter((m) => m.type === "image");
    const loadingMsg = await safeSendMessage(bot, chatId, "Загружаю...", {
      disable_notification: true
    });

    if (loadingMsg === null) {
      return;
    }

    let hasSuccessfulDownload = false;
    let photoProcessed = false;
    let videoProcessed = false;

    try {
      if (photos.length === 1) {
        photoProcessed = await processSinglePhoto(bot, chatId, photos[0], username);
        hasSuccessfulDownload = hasSuccessfulDownload || photoProcessed;
      } else if (photos.length > 1) {
        photoProcessed = await processMediaGroup(bot, chatId, photos, "photo", username);
        hasSuccessfulDownload = hasSuccessfulDownload || photoProcessed;
      }

      if (videos.length === 1) {
        videoProcessed = await processSingleVideo(bot, chatId, videos[0], username);
        hasSuccessfulDownload = hasSuccessfulDownload || videoProcessed;
      } else if (videos.length > 1) {
        videoProcessed = await processMediaGroup(bot, chatId, videos, "video", username);
        hasSuccessfulDownload = hasSuccessfulDownload || videoProcessed;
      }

      // Удаляем сообщение "Загружаю..." после обработки всех медиа
      if (loadingMsg) {
        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      }

      if (hasSuccessfulDownload) {
        recordDownload(
          chatId,
          message,
          platform,
          photos.length > 0 ? "photo" : "video",
          true,
          username,
          firstName
        );
      }
      else {
        recordDownload(
          chatId,
          message,
          platform,
          "unknown",
          false,
          username,
          firstName
        );
      }
    }
    catch (error: any) {
      if (error instanceof FileTooLargeError) {
        if (loadingMsg) {
          await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
        }
        await safeSendMessage(
          bot,
          chatId,
          "Файл слишком большой для загрузки. Максимальный размер: 50MB."
        );
        recordDownload(
          chatId,
          message,
          platform,
          "unknown",
          false,
          username,
          firstName
        );
        return;
      }

      if (loadingMsg) {
        await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      }
      recordDownload(
        chatId,
        message,
        platform,
        "unknown",
        false,
        username,
        firstName
      );
      await sendErrorToAdmin(
        bot,
        error,
        "main message handler",
        message,
        chatId,
        username
      );
    }
  }
  catch (error) {
    await safeSendMessage(
      bot,
      chatId,
      "Произошла ошибка при обработке запроса."
    );
    await sendErrorToAdmin(
      bot,
      error,
      "snapsave download",
      message,
      chatId,
      username
    );
    recordDownload(
      chatId,
      message,
      platform,
      "unknown",
      false,
      username,
      firstName
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
  "• YouTube Shorts",
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

  const userInfo = username? `@${username}`: firstName || `User ID: ${chatId}`;
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

// Функция для отправки сообщения о превышении лимита
export const sendRateLimitMessage = async (
  bot: TelegramBot,
  chatId: number,
  resetTime: number
): Promise<void> => {
  const resetDate = new Date(resetTime);
  const now = new Date();
  const minutesLeft = Math.ceil((resetTime - now.getTime()) / (60 * 1000));

  const message = [
    "⚠️ Превышен лимит запросов",
    "",
    `Вы можете отправлять максимум ${RATE_LIMIT_REQUESTS} запросов в минуту.`,
    `Попробуйте снова через ${minutesLeft} минут${
      minutesLeft === 1 ? "у" : minutesLeft < 5 ? "ы" : ""
    }.`,
    "",
    "Это ограничение помогает поддерживать стабильную работу бота для всех пользователей. 🤖"
  ].join("\n");

  await safeSendMessage(bot, chatId, message);
};
