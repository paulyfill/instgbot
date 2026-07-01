import TelegramBot from "node-telegram-bot-api";
import { snapsave } from "snapsave-media-downloader";
import { ADMIN_USERNAME, BOT_TAG } from "../config";
import { safeSendMessage, safeSendPhoto } from "../bot/safe-send";
import { FileTooLargeError, sendErrorToAdmin } from "../bot/errors";
import { fetchWithTimeout, processMediaGroup, processSinglePhoto, processSingleVideo } from "../media/download";
import { detectPlatform } from "../media/platform";
import { recordDownload } from "../db/queries";

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
        try {
          const imageBuffer = await convertTweetToImage(message);

          if (imageBuffer) {
            await safeSendPhoto(bot, chatId, imageBuffer, {
              caption: BOT_TAG,
              disable_notification: true
            });

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
    let hasSuccessfulDownload = false;
    let photoProcessed = false;
    let videoProcessed = false;

    try {
      if (photos.length === 1) {
        photoProcessed = await processSinglePhoto(bot, chatId, photos[0], username);
        hasSuccessfulDownload = hasSuccessfulDownload || photoProcessed;
      }
      else if (photos.length > 1) {
        photoProcessed = await processMediaGroup(bot, chatId, photos, "photo", username);
        hasSuccessfulDownload = hasSuccessfulDownload || photoProcessed;
      }

      if (videos.length === 1) {
        videoProcessed = await processSingleVideo(bot, chatId, videos[0], username);
        hasSuccessfulDownload = hasSuccessfulDownload || videoProcessed;
      }
      else if (videos.length > 1) {
        videoProcessed = await processMediaGroup(bot, chatId, videos, "video", username);
        hasSuccessfulDownload = hasSuccessfulDownload || videoProcessed;
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
