import TelegramBot from "node-telegram-bot-api";
import { youtube } from "btch-downloader";
import { BOT_TAG } from "../config";
import { safeDeleteMessage, safeSendMessage, safeSendVideo } from "../bot/safe-send";
import { FileTooLargeError, sendErrorToAdmin } from "../bot/errors";
import { downloadBuffer } from "../media/download";
import { detectPlatform } from "../media/platform";
import { recordDownload } from "../db/queries";

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
