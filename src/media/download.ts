import TelegramBot from "node-telegram-bot-api";
import { BOT_TAG } from "../config";
import { isBotBlockedError, safeSendMediaGroup, safeSendMessage, safeSendPhoto, safeSendVideo } from "../bot/safe-send";
import { FileTooLargeError, MediaFetchError, sendErrorToAdmin } from "../bot/errors";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const fetchWithTimeout = (url: string, timeoutMs = 30_000, options?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const downloadBuffer = async (url: string): Promise<Buffer> => {
  let response: Response;
  try {
    response = await fetchWithTimeout(url);
  }
  catch (e: any) {
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

export const processSingleMedia = async (
  bot: TelegramBot,
  chatId: number,
  item: { url?: string },
  type: "video" | "photo",
  username?: string
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
    }
    else {
      await safeSendPhoto(bot, chatId, buffer, { caption: BOT_TAG, disable_notification: true });
    }
    return true;
  }
  catch (error: any) {
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
        }
        catch (error) {
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
            }
            else {
              await safeSendPhoto(bot, chatId, buffer, { caption: i === 0 ? BOT_TAG : undefined, disable_notification: true });
            }
            if (i < mediaBuffers.length - 1) await new Promise(r => setTimeout(r, 200));
          }
          catch (e: any) {
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
