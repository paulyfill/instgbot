import TelegramBot from "node-telegram-bot-api";
import { Readable } from "node:stream";
import { InputFile } from "grammy";
import { BOT_TAG } from "../config";
import { grammyApi, isBotBlockedError, safeSendMessage, safeSendPhoto, safeSendVideo, withChatAction } from "../bot/safe-send";
import { FileTooLargeError, MediaFetchError, sendErrorToAdmin } from "../bot/errors";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const fetchWithTimeout = (url: string, timeoutMs = 30_000, options?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const fetchMediaResponse = async (url: string): Promise<Response> => {
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
  if (!response.ok) throw new MediaFetchError(`Сервер вернул ошибку ${response.status}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) throw new FileTooLargeError(parseInt(contentLength));
  return response;
};

export const downloadBuffer = async (url: string): Promise<Buffer> => {
  const response = await fetchMediaResponse(url);
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_FILE_SIZE) throw new FileTooLargeError(arrayBuffer.byteLength);
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

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchMediaResponse(item.url);
      const stream = Readable.fromWeb(response.body as any);
      const sendOpts = { caption: BOT_TAG, disable_notification: true, ...(type === "video" && { supports_streaming: true }) } as any;
      const action = type === "video" ? "upload_video" : "upload_photo";
      await withChatAction(bot, chatId, action, () =>
        type === "video" ? safeSendVideo(bot, chatId, stream, sendOpts) : safeSendPhoto(bot, chatId, stream, sendOpts)
      );
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
      const isTransient = /EFATAL|EPARSE/.test(String(error?.message || error));
      if (attempt === 0 && isTransient) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      await sendErrorToAdmin(bot, error, `single ${type}`, undefined, chatId, username);
      return false;
    }
  }
  return false;
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

  const ext = mediaType === "video" ? "mp4" : "jpg";
  const maxGroupSize = 40 * 1024 * 1024;

  for (let groupIndex = 0; groupIndex < mediaGroups.length; groupIndex++) {
    const group = mediaGroups[groupIndex];
    try {
      const fetchResults = await Promise.all(group.map(async (item, index) => {
        try {
          const response = await fetchMediaResponse(item.url);
          return { response, index, success: true as const };
        }
        catch (error) {
          console.error(`Failed to fetch item ${index}:`, error);
          return { response: null, index, success: false as const, error };
        }
      }));

      const valid = fetchResults.filter(r => r.success && r.response) as { response: Response, index: number, success: true }[];
      if (valid.length === 0) { console.log("No media fetched successfully"); continue; }

      const totalSize = valid.reduce((sum, { response }) => {
        const cl = response.headers.get("content-length");
        return sum + (cl ? parseInt(cl) : 0);
      }, 0);

      const action = mediaType === "video" ? "upload_video" : "upload_photo";
      if (totalSize > maxGroupSize) {
        for (const { response, index } of valid) {
          const stream = Readable.fromWeb(response.body as any);
          const opts = { caption: index === 0 ? BOT_TAG : undefined, disable_notification: true, ...(mediaType === "video" && { supports_streaming: true }) } as any;
          await withChatAction(bot, chatId, action, () =>
            mediaType === "video" ? safeSendVideo(bot, chatId, stream, opts) : safeSendPhoto(bot, chatId, stream, opts)
          );
          if (index < valid.length - 1) await new Promise(r => setTimeout(r, 200));
        }
      }
      else {
        const grammyMedia = valid.map(({ response, index }) => ({
          type: mediaType as "video" | "photo",
          media: new InputFile(Readable.fromWeb(response.body as any), `media_${index}.${ext}`),
          caption: index === 0 ? BOT_TAG : undefined,
          ...(mediaType === "video" && { supports_streaming: true }),
        }));
        await withChatAction(bot, chatId, action, () =>
          grammyApi.sendMediaGroup(chatId, grammyMedia as any, { disable_notification: true })
        );
      }

      if (groupIndex < mediaGroups.length - 1) {
        await new Promise(r => setTimeout(r, 500));
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
      if (isBotBlockedError(error)) return false;
      await sendErrorToAdmin(bot, error, `sendMediaGroup ${mediaType}s`, undefined, chatId, username);
      return false;
    }
  }

  return true;
};
