import TelegramBot from "node-telegram-bot-api";
import { youtube } from "btch-downloader";
import { Readable } from "node:stream";
import { InputFile } from "grammy";
import { BOT_TAG } from "../config";
import { grammyApi, safeSendVideo, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { FileTooLargeError, sendErrorToAdmin } from "../bot/errors";
import { fetchMediaResponse } from "../media/download";
import { detectPlatform } from "../media/platform";
import { getCachedFileId, recordDownload, setCachedFileId } from "../db/queries";

export const processYouTubeShorts = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  username?: string,
  firstName?: string
) => {
  const platform = detectPlatform(message);
  const postUrl = message.split("?")[0].replace(/\/$/, "");

  try {
    // Cache hit → instant send
    const cachedFileId = getCachedFileId(postUrl, "video", 0);
    if (cachedFileId) {
      await safeSendVideo(bot, chatId, cachedFileId, {
        caption: BOT_TAG,
        disable_notification: true,
        supports_streaming: true,
      } as any);
      recordDownload(chatId, message, platform, "video", true, username, firstName);
      return;
    }

    const response = await youtube(message);

    if (response && response.mp4) {
      try {
        const mediaResponse = await fetchMediaResponse(response.mp4);
        const stream = Readable.fromWeb(mediaResponse.body as any);

        await withChatAction(bot, chatId, "upload_video", async () => {
          const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, "video.mp4"), {
            caption: BOT_TAG,
            disable_notification: true,
            supports_streaming: true,
          } as any);
          setCachedFileId(postUrl, "video", 0, msg.video.file_id);
        });

        recordDownload(chatId, message, platform, "video", true, username, firstName);
      }
      catch (sendError: any) {
        if (sendError instanceof FileTooLargeError) {
          await safeSendMessage(bot, chatId, "Видео слишком большое для загрузки. Максимальный размер: 50MB.");
          recordDownload(chatId, message, platform, "video", false, username, firstName);
          return;
        }

        await safeSendMessage(bot, chatId, "Не удалось отправить видео с YouTube Shorts.");
        await sendErrorToAdmin(bot, sendError, "youtube video send", message, chatId, username);
        recordDownload(chatId, message, platform, "video", false, username, firstName);
      }
    }
    else {
      await safeSendMessage(bot, chatId, "Не удалось получить видео с YouTube Shorts.");
      await sendErrorToAdmin(bot, "No mp4 URL in YouTube response", "youtube mp4 check", message, chatId, username);
      recordDownload(chatId, message, platform, "video", false, username, firstName);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, "Не удалось скачать видео с YouTube Shorts. Попробуйте еще раз.");
    await sendErrorToAdmin(bot, error, "youtube download", message, chatId, username);
    recordDownload(chatId, message, platform, "video", false, username, firstName);
  }
};
