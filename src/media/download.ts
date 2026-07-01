import TelegramBot from "node-telegram-bot-api";
import { Readable } from "node:stream";
import { InputFile } from "grammy";
import { BOT_TAG } from "../config";
import { grammyApi, isBotBlockedError, safeSendMediaGroup, safeSendMessage, safeSendPhoto, safeSendVideo, withChatAction } from "../bot/safe-send";
import { FileTooLargeError, MediaFetchError, sendErrorToAdmin } from "../bot/errors";
import { getCachedFileId, setCachedFileId } from "../db/queries";

const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const fetchWithTimeout = (url: string, timeoutMs = 30_000, options?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export const fetchMediaResponse = async (url: string, skipSizeCheck = false): Promise<Response> => {
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
  if (!skipSizeCheck) {
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) throw new FileTooLargeError(parseInt(contentLength));
  }
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
  username?: string,
  postUrl?: string
): Promise<boolean> => {
  if (!item.url) {
    const sent = await safeSendMessage(bot, chatId, `Не удалось получить URL ${type === "video" ? "видео" : "фото"}.`);
    if (sent !== null) await sendErrorToAdmin(bot, `No ${type} URL`, `single ${type}`, undefined, chatId, username);
    return false;
  }

  const sendOpts = { caption: BOT_TAG, disable_notification: true, ...(type === "video" && { supports_streaming: true }) } as any;

  if (postUrl) {
    const fileId = getCachedFileId(postUrl, type, 0);
    if (fileId) {
      try {
        if (type === "video") await safeSendVideo(bot, chatId, fileId, sendOpts);
        else await safeSendPhoto(bot, chatId, fileId, sendOpts);
        return true;
      }
      catch (err: any) {
        if (isBotBlockedError(err)) return false;
        // stale file_id — fall through to re-download
      }
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchMediaResponse(item.url);
      const stream = Readable.fromWeb(response.body as any);
      const action = type === "video" ? "upload_video" : "upload_photo";
      await withChatAction(bot, chatId, action, async () => {
        if (type === "video") {
          const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, "video.mp4"), sendOpts);
          if (postUrl) setCachedFileId(postUrl, type, 0, msg.video.file_id);
        }
        else {
          const msg = await grammyApi.sendPhoto(chatId, new InputFile(stream, "photo.jpg"), sendOpts);
          if (postUrl) setCachedFileId(postUrl, type, 0, msg.photo[msg.photo.length - 1].file_id);
        }
      });
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

export const processSingleVideo = (bot: TelegramBot, chatId: number, video: { url?: string }, username?: string, postUrl?: string) =>
  processSingleMedia(bot, chatId, video, "video", username, postUrl);

export const processSinglePhoto = (bot: TelegramBot, chatId: number, photo: { url?: string }, username?: string, postUrl?: string) =>
  processSingleMedia(bot, chatId, photo, "photo", username, postUrl);

export const processMediaGroup = async (
  bot: TelegramBot,
  chatId: number,
  mediaItems: any[],
  mediaType: "video" | "photo",
  username?: string,
  postUrl?: string
): Promise<boolean> => {
  const validMedia = mediaItems.filter(
    (item) => item.url !== undefined && (item.type === "video" || item.type === "image")
  );
  if (validMedia.length === 0) return false;

  const groupSize = mediaType === "video" ? 3 : 10;
  const mediaGroups: (typeof validMedia)[] = [];
  for (let i = 0; i < validMedia.length; i += groupSize) {
    mediaGroups.push(validMedia.slice(i, i + groupSize));
  }

  // All items cached → instant send, no downloading
  if (postUrl && validMedia.every((_, i) => getCachedFileId(postUrl, mediaType, i) !== null)) {
    for (let groupIndex = 0; groupIndex < mediaGroups.length; groupIndex++) {
      const group = mediaGroups[groupIndex];
      const cachedMedia = group.map((_, localIndex) => {
        const globalIndex = groupIndex * groupSize + localIndex;
        return {
          type: mediaType as "video" | "photo",
          media: getCachedFileId(postUrl, mediaType, globalIndex)!,
          caption: groupIndex === 0 && localIndex === 0 ? BOT_TAG : undefined
        };
      });

      if (cachedMedia.length === 1) {
        const { media, caption } = cachedMedia[0];
        const opts = { caption, disable_notification: true, ...(mediaType === "video" && { supports_streaming: true }) } as any;
        if (mediaType === "video") await safeSendVideo(bot, chatId, media, opts);
        else await safeSendPhoto(bot, chatId, media, opts);
      }
      else {
        await safeSendMediaGroup(bot, chatId, cachedMedia as any, { disable_notification: true });
      }

      if (groupIndex < mediaGroups.length - 1) await new Promise(r => setTimeout(r, 500));
    }
    return true;
  }

  const ext = mediaType === "video" ? "mp4" : "jpg";
  const maxGroupSize = 40 * 1024 * 1024;

  for (let groupIndex = 0; groupIndex < mediaGroups.length; groupIndex++) {
    const group = mediaGroups[groupIndex];
    try {
      const fetchResults = await Promise.all(group.map(async (item, localIndex) => {
        try {
          const response = await fetchMediaResponse(item.url);
          return { response, localIndex, success: true as const };
        }
        catch (error) {
          console.error(`Failed to fetch item ${localIndex}:`, error);
          return { response: null, localIndex, success: false as const, error };
        }
      }));

      const valid = fetchResults.filter(r => r.success && r.response) as { response: Response, localIndex: number, success: true }[];
      if (valid.length === 0) { console.log("No media fetched successfully"); continue; }

      const totalSize = valid.reduce((sum, { response }) => {
        const cl = response.headers.get("content-length");
        return sum + (cl ? parseInt(cl) : 0);
      }, 0);

      const action = mediaType === "video" ? "upload_video" : "upload_photo";

      if (totalSize > maxGroupSize) {
        for (let i = 0; i < valid.length; i++) {
          const { response, localIndex } = valid[i];
          const globalIndex = groupIndex * groupSize + localIndex;
          const stream = Readable.fromWeb(response.body as any);
          const opts = { caption: groupIndex === 0 && localIndex === 0 ? BOT_TAG : undefined, disable_notification: true, ...(mediaType === "video" && { supports_streaming: true }) } as any;
          await withChatAction(bot, chatId, action, async () => {
            if (mediaType === "video") {
              const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, "video.mp4"), opts);
              if (postUrl) setCachedFileId(postUrl, mediaType, globalIndex, msg.video.file_id);
            }
            else {
              const msg = await grammyApi.sendPhoto(chatId, new InputFile(stream, "photo.jpg"), opts);
              if (postUrl) setCachedFileId(postUrl, mediaType, globalIndex, msg.photo[msg.photo.length - 1].file_id);
            }
          });
          if (i < valid.length - 1) await new Promise(r => setTimeout(r, 200));
        }
      }
      else {
        const grammyMedia = valid.map(({ response, localIndex }) => ({
          type: mediaType as "video" | "photo",
          media: new InputFile(Readable.fromWeb(response.body as any), `media_${localIndex}.${ext}`),
          caption: groupIndex === 0 && localIndex === 0 ? BOT_TAG : undefined,
          ...(mediaType === "video" && { supports_streaming: true })
        }));
        const messages = await withChatAction(bot, chatId, action, () =>
          grammyApi.sendMediaGroup(chatId, grammyMedia as any, { disable_notification: true })
        );
        if (postUrl && messages) {
          messages.forEach((msg: any, i: number) => {
            const globalIndex = groupIndex * groupSize + valid[i].localIndex;
            const fileId = mediaType === "video"? msg.video?.file_id: msg.photo?.[msg.photo?.length - 1]?.file_id;
            if (fileId) setCachedFileId(postUrl, mediaType, globalIndex, fileId);
          });
        }
      }

      if (groupIndex < mediaGroups.length - 1) await new Promise(r => setTimeout(r, 500));
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
