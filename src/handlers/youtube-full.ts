// @ts-ignore - no types
import yt from "@vreden/youtube_scraper";
import type TelegramBot from "node-telegram-bot-api";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { InputFile } from "grammy";
import { BOT_TAG } from "../config";
import { grammyApi, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { fetchMediaResponse } from "../media/download";
import { checkYouTubeRateLimit } from "../bot/rate-limit";
import { getCachedFileId, setCachedFileId } from "../db/queries";
import { getBotMtproto } from "../bot/mtproto";
import { Api } from "telegram";

const GRAMMY_LIMIT_MB = 50;

type PendingDownload = {
  url: string;
  title: string;
  availableQualities: number[];
  estimatedMB: Record<number, number>; // quality → MB
};

export const pendingYouTube = new Map<number, PendingDownload>();

export const sendYouTubeQualityPicker = async (
  bot: TelegramBot,
  chatId: number,
  url: string,
  username?: string
) => {
  try {
    const probe = await yt.ytmp4(url, 360);

    if (!probe?.download?.status) {
      await safeSendMessage(bot, chatId, "Не удалось получить информацию о видео.");
      return;
    }

    const title: string = probe.metadata?.title ?? "YouTube видео";
    const qualities: number[] = probe.download.availableQuality ?? [360];
    const durationSec: number = probe.metadata?.seconds ?? 0;

    const videoBitrates: Record<number, number> = { 144: 150, 360: 500, 480: 1000, 720: 2500, 1080: 5000 };
    const calcMB = (kbps: number) => durationSec ? (kbps * durationSec) / 8 / 1024 : 0;

    const estimatedMB: Record<number, number> = {};
    qualities.forEach(q => { estimatedMB[q] = calcMB(videoBitrates[q] ?? 1000); });

    pendingYouTube.set(chatId, { url, title, availableQualities: qualities, estimatedMB });
    setTimeout(() => pendingYouTube.delete(chatId), 5 * 60 * 1000);

    const fmtSize = (mb: number) => mb <= 0 ? null : mb >= 1024 ? `~${(mb / 1024).toFixed(1)} ГБ` : `~${Math.round(mb)} МБ`;

    const videoButtons = qualities
      .filter(q => !durationSec || estimatedMB[q] < 2048)
      .map(q => {
        const size = fmtSize(estimatedMB[q]);
        const cached = getCachedFileId(url, `yt_v_${q}`) ? "⚡ " : "";
        return [{ text: `${cached}🎬 ${q}p${size ? ` (${size})` : ""}`, callback_data: `yt:${chatId}:v:${q}` }];
      });

    const audioBitrates: Record<number, number> = { 128: 128, 320: 320 };
    const audioButtons = [128, 320].map(q => {
      const size = fmtSize(calcMB(audioBitrates[q]));
      const cached = getCachedFileId(url, `yt_a_${q}`) ? "⚡ " : "";
      return [{ text: `${cached}🎵 MP3 ${q}kbps${size ? ` (${size})` : ""}`, callback_data: `yt:${chatId}:a:${q}` }];
    });

    await bot.sendMessage(chatId, `🎬 <b>${title}</b>\n\nВыберите формат:\n<i>Максимум в Telegram — 2 ГБ</i>`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [...videoButtons, ...audioButtons] }
    });
  }
  catch (error) {
    await safeSendMessage(bot, chatId, "Не удалось получить информацию о видео.");
    await sendErrorToAdmin(bot, error, "youtube quality picker", url, chatId, username);
  }
};


export const handleYouTubeCallback = async (
  bot: TelegramBot,
  chatId: number,
  type: "v" | "a",
  quality: number,
  userId: number,
  username?: string
) => {
  const rateLimit = checkYouTubeRateLimit(userId);
  if (!rateLimit.allowed) {
    const sec = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
    await safeSendMessage(bot, chatId, `⚡ Лимит: 1 загрузка в 3 минуты. Повторите через ${sec} сек.`);
    return;
  }

  const pending = pendingYouTube.get(chatId);
  if (!pending) {
    await safeSendMessage(bot, chatId, "Сессия истекла. Отправьте ссылку заново.");
    return;
  }

  pendingYouTube.delete(chatId);
  const { url, title, estimatedMB } = pending;
  const cacheKey = url;
  const cacheType = `yt_${type}_${quality}`;
  const isLarge = type === "v" && (estimatedMB[quality] ?? 0) > GRAMMY_LIMIT_MB;

  try {
    if (type === "a") {
      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendAudio(chatId, cached, { caption: BOT_TAG, disable_notification: true } as any);
        return;
      }
      await withChatAction(bot, chatId, "upload_document", async () => {
        const result = await yt.ytmp3(url, quality);
        if (!result?.download?.url) throw new Error("No audio URL");
        const resp = await fetchMediaResponse(result.download.url);
        const stream = Readable.fromWeb(resp.body as any);
        const msg = await grammyApi.sendAudio(chatId, new InputFile(stream, `${title}.mp3`), {
          title,
          caption: BOT_TAG,
          disable_notification: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.audio.file_id);
      });
      return;
    }

    // Video
    const result = await yt.ytmp4(url, quality);
    if (!result?.download?.url) throw new Error("No video URL");

    if (isLarge) {
      await withChatAction(bot, chatId, "upload_video", async () => {
        const client = await getBotMtproto();

        const cachedRef = getCachedFileId(cacheKey, cacheType);
        if (cachedRef) {
          try {
            const [idStr, hashStr, refHex] = cachedRef.split(":");
            const inputMedia = new Api.InputMediaDocument({
              id: new Api.InputDocument({
                id: BigInt(idStr) as any,
                accessHash: BigInt(hashStr) as any,
                fileReference: Buffer.from(refHex, "hex")
              })
            });
            await client.sendFile(chatId, {
              file: inputMedia,
              caption: `${title}\n\n${BOT_TAG}`,
              supportsStreaming: true,
              silent: true
            });
            return;
          }
          catch {
            // stale reference — fall through to re-download
          }
        }

        // First send: download CDN → temp file → MTProto upload
        const tmpPath = `${tmpdir()}/yt_${Date.now()}.mp4`;
        const resp = await fetchMediaResponse(result.download.url, true);
        const writer = createWriteStream(tmpPath);
        await new Promise<void>((res, rej) => {
          Readable.fromWeb(resp.body as any).pipe(writer);
          writer.on("finish", res);
          writer.on("error", rej);
        });
        try {
          const msg = await client.sendFile(chatId, {
            file: tmpPath,
            caption: `${title}\n\n${BOT_TAG}`,
            supportsStreaming: true,
            silent: true
          }) as Api.Message;

          // Cache MTProto document reference for future sends
          const doc = (msg?.media as Api.MessageMediaDocument)?.document as Api.Document | undefined;
          if (doc?.id && doc?.accessHash && doc?.fileReference) {
            const ref = `${doc.id}:${doc.accessHash}:${Buffer.from(doc.fileReference).toString("hex")}`;
            setCachedFileId(cacheKey, cacheType, 0, ref);
          }
        }
        finally {
          await unlink(tmpPath).catch(() => {});
        }
      });
    }
    else {
      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendVideo(chatId, cached, {
          caption: `${title}\n\n${BOT_TAG}`,
          disable_notification: true,
          supports_streaming: true
        } as any);
        return;
      }
      await withChatAction(bot, chatId, "upload_video", async () => {
        const resp = await fetchMediaResponse(result.download.url);
        const stream = Readable.fromWeb(resp.body as any);
        const rnd = Math.floor(Math.random() * 100000) + 1;
        const fname = `video_${new Date().toISOString().slice(0, 10)}_${rnd}.mp4`;
        const msg = await grammyApi.sendVideo(chatId, new InputFile(stream, fname), {
          caption: `${title}\n\n${BOT_TAG}`,
          disable_notification: true,
          supports_streaming: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.video.file_id);
      });
    }
  }
  catch (error: any) {
    console.log("YouTube download error:", error);
    await safeSendMessage(bot, chatId, "Не удалось скачать. Попробуйте ещё раз.");
    await sendErrorToAdmin(bot, error, "youtube download", url, chatId, username);
  }
};
