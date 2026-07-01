import TelegramBot from "node-telegram-bot-api";
import { Bot as GrammyBot, InputFile } from "grammy";
import type { Readable } from "node:stream";

// ponytail: grammy api used only for streaming uploads, polling stays on node-telegram-bot-api
export const grammyApi = new GrammyBot(Bun.env.TELEGRAM_BOT!).api;

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
  }
  catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeSendVideo = async (
  bot: TelegramBot,
  chatId: number,
  video: string | Buffer | Readable,
  options?: TelegramBot.SendVideoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    if (video instanceof Buffer || typeof video === "string") {
      return await bot.sendVideo(chatId, video, options);
    }
    await grammyApi.sendVideo(chatId, new InputFile(video, "video.mp4"), options as any);
    return null;
  }
  catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const safeSendPhoto = async (
  bot: TelegramBot,
  chatId: number,
  photo: string | Buffer | Readable,
  options?: TelegramBot.SendPhotoOptions
): Promise<TelegramBot.Message | null> => {
  try {
    if (photo instanceof Buffer || typeof photo === "string") {
      return await bot.sendPhoto(chatId, photo, options);
    }
    await grammyApi.sendPhoto(chatId, new InputFile(photo, "photo.jpg"), options as any);
    return null;
  }
  catch (error: any) {
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
  }
  catch (error: any) {
    if (isBotBlockedError(error)) return null;
    throw error;
  }
};

export const withChatAction = async <T>(
  bot: TelegramBot,
  chatId: number,
  action: TelegramBot.ChatAction,
  fn: () => Promise<T>
): Promise<T> => {
  bot.sendChatAction(chatId, action).catch(() => {});
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, action).catch(() => {});
  }, 4000);
  try {
    return await fn();
  }
  finally {
    clearInterval(interval);
  }
};

export const safeDeleteMessage = async (
  bot: TelegramBot,
  chatId: number,
  messageId: number
): Promise<boolean> => {
  try {
    return await bot.deleteMessage(chatId, messageId);
  }
  catch (error: any) {
    return false;
  }
};
