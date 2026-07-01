import TelegramBot from "node-telegram-bot-api";
import { BOT_TAG } from "../config";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { processMediaGroup, processSinglePhoto, processSingleVideo } from "../media/download";
import { detectPlatform } from "../media/platform";
import { recordDownload } from "../db/queries";

type ThreadsApiResponse = {
  image_urls: string[];
  video_urls: { download_url: string }[];
};

const fetchWithTimeout = (url: string, timeoutMs = 30_000, options?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
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
