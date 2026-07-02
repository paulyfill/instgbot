import TelegramBot from "node-telegram-bot-api";
import { BOT_TAG } from "../config";
import { safeDeleteMessage, safeSendMediaGroup, safeSendMessage, safeSendPhoto, safeSendVideo } from "../bot/safe-send";
import { FileTooLargeError, sendErrorToAdmin } from "../bot/errors";
import { Api } from "telegram";
import { recordDownload } from "../db/queries";

export async function downloadStoryById ({
  userClient,
  bot,
  username,
  storyId,
  chatId
}: {
  userClient: any;
  bot: TelegramBot;
  username: string;
  storyId: number;
  chatId: number;
}): Promise<boolean> {
  let loadingMsg: TelegramBot.Message | null = null;
  try {
    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю сторис...", { disable_notification: true });
    const peer = await userClient.getEntity(username);
    const result = await userClient.invoke(
      new Api.stories.GetStoriesByID({ peer, id: [storyId] })
    );

    const stories = result.stories;
    if (!stories || stories.length === 0) {
      await safeSendMessage(bot, chatId, `Сторис #${storyId} не найдена у @${username}.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    const story = stories[0];
    if (!("media" in story) || !story.media) {
      await safeSendMessage(bot, chatId, `Сторис #${storyId} не содержит медиа.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    const mediaResult = await userClient.downloadMedia(story.media);
    if (!Buffer.isBuffer(mediaResult)) {
      await safeSendMessage(bot, chatId, `Не удалось скачать сторис #${storyId}.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    const mediaClassName = ("className" in story.media) ? story.media.className : "";
    if (mediaClassName === "MessageMediaPhoto") {
      await safeSendPhoto(bot, chatId, mediaResult, { caption: BOT_TAG, disable_notification: true });
    }
    else {
      await safeSendVideo(bot, chatId, mediaResult, { caption: BOT_TAG, disable_notification: true, supports_streaming: true });
    }

    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    recordDownload(chatId, `t.me/${username}/s/${storyId}`, "telegram", "story", true, username);
    return true;
  }
  catch (error: any) {
    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    await safeSendMessage(bot, chatId, `Ошибка при загрузке сторис. Попробуйте позже.\n${BOT_TAG}`);
    await sendErrorToAdmin(bot, error, "telegram stories download", undefined, chatId, username);
    return false;
  }
}

const isNoAccessError = (error: any): boolean => {
  const msg: string = error?.message || String(error);
  return (
    msg.includes("CHANNEL_PRIVATE") ||
    msg.includes("USER_NOT_PARTICIPANT") ||
    msg.includes("CHAT_ADMIN_REQUIRED") ||
    msg.includes("Cannot find any entity") ||
    msg.includes("Could not find the input entity")
  );
};

// Fetches all messages in an album if grouped, otherwise returns single message
const getPostMessages = async (userClient: any, peer: any, messageId: number): Promise<any[]> => {
  const [message] = await userClient.getMessages(peer, { ids: [messageId] });
  if (!message) return [];
  if (!message.groupedId) return [message];

  const groupId = message.groupedId.toString();
  // Fetch a window around the message to get all album items
  const batch = await userClient.getMessages(peer, {
    offsetId: messageId + 10,
    limit: 20
  });
  const album = batch.filter((m: any) => m.groupedId?.toString() === groupId);
  return album.length > 0 ? album : [message];
};

const sendPostMedia = async (
  bot: TelegramBot,
  chatId: number,
  userClient: any,
  messages: any[]
): Promise<boolean> => {
  const withMedia = messages.filter((m: any) => m.media);
  if (withMedia.length === 0) return false;

  if (withMedia.length === 1) {
    const mediaResult = await userClient.downloadMedia(withMedia[0].media);
    if (!Buffer.isBuffer(mediaResult)) return false;
    const cls = withMedia[0].media?.className ?? "";
    if (cls === "MessageMediaPhoto") {
      await safeSendPhoto(bot, chatId, mediaResult, { caption: BOT_TAG, disable_notification: true });
    }
    else {
      await safeSendVideo(bot, chatId, mediaResult, { caption: BOT_TAG, disable_notification: true, supports_streaming: true });
    }
    return true;
  }

  // Album: download all in parallel
  const downloaded = await Promise.all(
    withMedia.map(async (m: any, i: number) => {
      const buf = await userClient.downloadMedia(m.media);
      if (!Buffer.isBuffer(buf)) return null;
      const cls = m.media?.className ?? "";
      return {
        type: cls === "MessageMediaPhoto" ? "photo" : "video",
        media: buf as any,
        caption: i === 0 ? BOT_TAG : undefined
      };
    })
  );
  const valid = downloaded.filter(Boolean) as TelegramBot.InputMedia[];
  if (valid.length === 0) return false;
  await safeSendMediaGroup(bot, chatId, valid, { disable_notification: true });
  return true;
};

export async function downloadTelegramPost ({
  userClient,
  bot,
  username,
  postId,
  chatId
}: {
  userClient: any;
  bot: TelegramBot;
  username: string;
  postId: number;
  chatId: number;
}): Promise<boolean> {
  let loadingMsg: TelegramBot.Message | null = null;
  try {
    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю пост...", { disable_notification: true });
    const peer = await userClient.getEntity(username);
    const messages = await getPostMessages(userClient, peer, postId);

    if (messages.length === 0) {
      await safeSendMessage(bot, chatId, `Пост не найден у @${username}.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    const sent = await sendPostMedia(bot, chatId, userClient, messages);
    if (!sent) {
      await safeSendMessage(bot, chatId, `Пост не содержит медиа.\n${BOT_TAG}`);
    }

    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    recordDownload(chatId, `t.me/${username}/${postId}`, "telegram", "post", sent, username);
    return sent;
  }
  catch (error: any) {
    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    if (isNoAccessError(error)) {
      await safeSendMessage(bot, chatId, `Нет доступа к каналу @${username}. Возможно, канал приватный.\n${BOT_TAG}`);
      return false;
    }
    await safeSendMessage(bot, chatId, `Ошибка при загрузке поста. Попробуйте позже.\n${BOT_TAG}`);
    await sendErrorToAdmin(bot, error, "telegram post download", undefined, chatId, username);
    return false;
  }
}

export async function downloadPrivateTelegramPost ({
  userClient,
  bot,
  channelId,
  messageId,
  chatId
}: {
  userClient: any;
  bot: TelegramBot;
  channelId: bigint;
  messageId: number;
  chatId: number;
}): Promise<boolean> {
  let loadingMsg: TelegramBot.Message | null = null;
  try {
    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю пост...", { disable_notification: true });
    const peer = await userClient.getEntity(channelId);
    const messages = await getPostMessages(userClient, peer, messageId);

    if (messages.length === 0) {
      await safeSendMessage(bot, chatId, `Пост не найден.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    const sent = await sendPostMedia(bot, chatId, userClient, messages);
    if (!sent) {
      await safeSendMessage(bot, chatId, `Пост не содержит медиа.\n${BOT_TAG}`);
    }

    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    recordDownload(chatId, `t.me/c/${channelId}/${messageId}`, "telegram", "post", sent);
    return sent;
  }
  catch (error: any) {
    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    if (isNoAccessError(error)) {
      await safeSendMessage(bot, chatId, `Нет доступа к этому каналу. Возможно, бот не является участником или канал приватный.\n${BOT_TAG}`);
      return false;
    }
    await safeSendMessage(bot, chatId, `Ошибка при загрузке поста. Попробуйте позже.\n${BOT_TAG}`);
    await sendErrorToAdmin(bot, error, "telegram post download", undefined, chatId);
    return false;
  }
}

export async function downloadStories ({
  userClient,
  bot,
  username,
  chatId
}: {
  userClient: any;
  bot: TelegramBot;
  username: string;
  chatId: number;
}): Promise<boolean> {
  let loadingMsg: TelegramBot.Message | null = null;
  try {
    loadingMsg = await safeSendMessage(bot, chatId, "Загружаю сторис...", { disable_notification: true });
    const peer = await userClient.getEntity(username);
    const result = await userClient.invoke(
      new Api.stories.GetPeerStories({ peer })
    );

    if (!result.stories || result.stories.stories.length === 0) {
      await safeSendMessage(bot, chatId, `Не удалось найти публичные сторис у @${username}. Возможно, пользователь скрыл свои сторис или у него нет публичных сторис.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }

    let successCount = 0;
    let photoBatch: TelegramBot.InputMedia[] = [];
    let videoBatch: TelegramBot.InputMedia[] = [];

    const flushBatch = async (batch: TelegramBot.InputMedia[], context: string) => {
      if (batch.length === 0) return;
      const withCaption = batch.map((item, idx) => idx === 0 ? { ...item, caption: BOT_TAG } : item);
      try {
        await safeSendMediaGroup(bot, chatId, withCaption);
      }
      catch (e) {
        await sendErrorToAdmin(bot, e, context, undefined, chatId, username);
      }
      batch.length = 0;
    };

    for (const story of result.stories.stories) {
      if (!("media" in story) || !story.media) continue;
      let fileBuffer: Buffer | undefined;
      try {
        const mediaResult = await userClient.downloadMedia(story.media);
        if (Buffer.isBuffer(mediaResult)) fileBuffer = mediaResult;
        else continue;
      }
      catch (e: any) {
        if (e instanceof FileTooLargeError) {
          await safeSendMessage(bot, chatId, `Сторис слишком большой для загрузки (максимум 50MB).\n${BOT_TAG}`);
        }
        else {
          await sendErrorToAdmin(bot, e, "telegram stories download", undefined, chatId, username);
        }
        continue;
      }
      if (!fileBuffer) continue;

      const mediaClassName = ("className" in story.media) ? story.media.className : "";
      if (mediaClassName === "MessageMediaPhoto") {
        photoBatch.push({ type: "photo", media: fileBuffer as any });
        successCount++;
        if (photoBatch.length === 10) await flushBatch(photoBatch, "sendMediaGroup photos");
      }
      else if (mediaClassName === "MessageMediaDocument") {
        videoBatch.push({ type: "video", media: fileBuffer as any });
        successCount++;
        if (videoBatch.length === 10) await flushBatch(videoBatch, "sendMediaGroup videos");
      }
    }

    await flushBatch(photoBatch, "sendMediaGroup photos");
    await flushBatch(videoBatch, "sendMediaGroup videos");

    if (successCount === 0) {
      await safeSendMessage(bot, chatId, `Сторис найдены, но не удалось загрузить медиа. Возможно, они недоступны.\n${BOT_TAG}`);
      if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
      return false;
    }
    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    try {
      await recordDownload(chatId, username, "telegram", "story", true, username);
    }
    catch (e) {
      console.error("Ошибка записи сторис в БД:", e);
    }
    return true;
  }
  catch (error: any) {
    if (loadingMsg) await safeDeleteMessage(bot, chatId, loadingMsg.message_id);
    await safeSendMessage(bot, chatId, `Ошибка при загрузке сторис. Попробуйте позже.\n${BOT_TAG}`);
    await sendErrorToAdmin(bot, error, "telegram stories download", undefined, chatId, username);
    return false;
  }
}
