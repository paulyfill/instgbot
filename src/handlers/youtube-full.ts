import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import type TelegramBot from "node-telegram-bot-api";
import { InputFile } from "grammy";
import { CustomFile } from "telegram/client/uploads";
import { BOT_TAG } from "../config";
import { grammyApi, withChatAction } from "../bot/safe-send";
import { safeSendMessage } from "../bot/safe-send";
import { sendErrorToAdmin } from "../bot/errors";
import { checkYouTubeRateLimit } from "../bot/rate-limit";
import { getCachedFileId, setCachedFileId } from "../db/queries";
import { getBotMtproto } from "../bot/mtproto";
import { Api } from "telegram";

const GRAMMY_LIMIT_MB = 50;
const YT_DLP = process.env.YT_DLP_PATH ?? "yt-dlp";

const ytDlp = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const proc = spawn(YT_DLP, args);
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || `yt-dlp exit ${code}`)));
  });

const ytDlpStream = (args: string[]): Readable => {
  const proc = spawn(YT_DLP, args);
  return proc.stdout as unknown as Readable;
};

type VideoFormat = { formatId: string, quality: number, sizeMB: number, sizeBytes: number, ext: string };
type AudioFormat = { formatId: string, bitrateKbps: number, sizeMB: number };

type YtInfo = {
  title: string;
  videoFormats: VideoFormat[];
  audioFormats: AudioFormat[];
};

const parseYtInfo = (raw: string): YtInfo => {
  const info = JSON.parse(raw);
  const title: string = info.title ?? "YouTube видео";
  const durationSec: number = info.duration ?? 0;

  const muxed: VideoFormat[] = (info.formats ?? [])
    .filter((f: any) => f.vcodec !== "none" && f.acodec !== "none")
    .map((f: any) => {
      const sizeBytes: number = f.filesize ?? 0;
      const sizeMB = sizeBytes ? Math.round(sizeBytes / 1024 / 1024) :f.filesize_approx ? Math.round(f.filesize_approx / 1024 / 1024) :durationSec && f.tbr ? Math.round((f.tbr * durationSec) / 8 / 1024) : 0;
      return { formatId: f.format_id, quality: f.height ?? 0, sizeMB, sizeBytes, ext: f.ext };
    })
    .filter((f: VideoFormat) => f.quality > 0);

  const byQuality = new Map<number, VideoFormat>();
  for (const f of muxed) {
    const existing = byQuality.get(f.quality);
    if (!existing) { byQuality.set(f.quality, f); continue; }
    const preferNew = (f.ext === "mp4" && existing.ext !== "mp4") || (f.ext === existing.ext && f.sizeMB > existing.sizeMB);
    if (preferNew) byQuality.set(f.quality, f);
  }
  const videoFormats = Array.from(byQuality.values()).sort((a, b) => a.quality - b.quality);

  const audio: AudioFormat[] = (info.formats ?? [])
    .filter((f: any) => f.vcodec === "none" && f.acodec !== "none")
    .map((f: any) => ({
      formatId: f.format_id,
      bitrateKbps: Math.round((f.abr ?? f.tbr ?? 0)),
      sizeMB: f.filesize ? Math.round(f.filesize / 1024 / 1024) :durationSec && (f.abr ?? f.tbr) ? Math.round(((f.abr ?? f.tbr) * durationSec) / 8 / 1024) : 0
    }))
    .filter((f: AudioFormat) => f.bitrateKbps > 0)
    .sort((a: AudioFormat, b: AudioFormat) => a.bitrateKbps - b.bitrateKbps);

  return { title, videoFormats, audioFormats: audio };
};

const YT_ARGS = ["--dump-json", "--no-playlist", "--no-cache-dir"];

const ytInfoCache = new Map<string, { info: YtInfo, expiresAt: number }>();

const getYtInfo = async (url: string): Promise<YtInfo> => {
  const cached = ytInfoCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.info;

  const raw = await ytDlp([...YT_ARGS, url]);
  const result = parseYtInfo(raw);
  // YouTube sometimes returns truncated format list on first request — retry once
  if (result.videoFormats.length <= 1) {
    const raw2 = await ytDlp([...YT_ARGS, url]);
    const result2 = parseYtInfo(raw2);
    ytInfoCache.set(url, { info: result2, expiresAt: Date.now() + 5 * 60 * 1000 });
    return result2;
  }
  ytInfoCache.set(url, { info: result, expiresAt: Date.now() + 5 * 60 * 1000 });
  return result;
};

const mkfifo = (path: string): Promise<void> =>
  new Promise((res, rej) =>
    spawn("mkfifo", [path]).on("close", code => code === 0 ? res() : rej(new Error(`mkfifo exit ${code}`)))
  );

type PendingDownload = {
  url: string;
  title: string;
  videoFormats: VideoFormat[];
  audioFormats: AudioFormat[];
};

export const pendingYouTube = new Map<number, PendingDownload>();

export const sendYouTubeQualityPicker = async (
  bot: TelegramBot,
  chatId: number,
  url: string,
  username?: string
) => {
  try {
    await withChatAction(bot, chatId, "typing", async () => {
      const { title, videoFormats, audioFormats } = await getYtInfo(url);

      if (videoFormats.length === 0 && audioFormats.length === 0) {
        await safeSendMessage(bot, chatId, "Не удалось получить информацию о видео.");
        return;
      }

      pendingYouTube.set(chatId, { url, title, videoFormats, audioFormats });
      setTimeout(() => pendingYouTube.delete(chatId), 5 * 60 * 1000);

      const fmtSize = (mb: number) =>
        mb <= 0 ? null : mb >= 1024 ? `~${(mb / 1024).toFixed(1)} ГБ` : `~${mb} МБ`;

      const videoButtons = videoFormats
        .filter(f => f.sizeMB <= 0 || f.sizeMB < 2048)
        .map(f => {
          const size = fmtSize(f.sizeMB);
          const cached = getCachedFileId(url, `yt_v_${f.quality}`) ? "⚡ " : "";
          return [{ text: `${cached}🎬 ${f.quality}p${size ? ` (${size})` : ""}`, callback_data: `yt:${chatId}:v:${f.quality}` }];
        });

      // Show up to 2 audio options (lowest ~128, highest ~320)
      const audioOptions: AudioFormat[] = [];
      if (audioFormats.length > 0) audioOptions.push(audioFormats[0]);
      if (audioFormats.length > 1) audioOptions.push(audioFormats[audioFormats.length - 1]);
      const audioButtons = audioOptions.map(f => {
        const size = fmtSize(f.sizeMB);
        const cached = getCachedFileId(url, `yt_a_${f.bitrateKbps}`) ? "⚡ " : "";
        return [{ text: `${cached}🎵 MP3 ${f.bitrateKbps}kbps${size ? ` (${size})` : ""}`, callback_data: `yt:${chatId}:a:${f.bitrateKbps}` }];
      });

      await bot.sendMessage(chatId, `🎬 <b>${title}</b>\n\nВыберите формат:\n<i>Максимум в Telegram — 2 ГБ</i>`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [...videoButtons, ...audioButtons] }
      });
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
  const { url, title, videoFormats, audioFormats } = pending;
  const cacheKey = url;
  const cacheType = `yt_${type}_${quality}`;

  try {
    if (type === "a") {
      const cached = getCachedFileId(cacheKey, cacheType);
      if (cached) {
        await grammyApi.sendAudio(chatId, cached, { caption: BOT_TAG, disable_notification: true } as any);
        return;
      }

      const fmt = audioFormats.find(f => f.bitrateKbps === quality)
        ?? audioFormats[audioFormats.length - 1];
      if (!fmt) throw new Error("No audio format found");

      await withChatAction(bot, chatId, "upload_document", async () => {
        const stream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
        const msg = await grammyApi.sendAudio(chatId, new InputFile(stream, `${title}.m4a`), {
          title,
          caption: BOT_TAG,
          disable_notification: true
        } as any);
        setCachedFileId(cacheKey, cacheType, 0, msg.audio.file_id);
      });
      return;
    }

    // Video
    const fmt = videoFormats.find(f => f.quality === quality);
    if (!fmt) throw new Error("No video format found");

    const isLarge = fmt.sizeMB > GRAMMY_LIMIT_MB;

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

        const sendAndCache = async (file: any) => {
          const msg = await client.sendFile(chatId, {
            file,
            caption: `${title}\n\n${BOT_TAG}`,
            supportsStreaming: true,
            silent: true
          }) as Api.Message;
          const doc = (msg?.media as Api.MessageMediaDocument)?.document as Api.Document | undefined;
          if (doc?.id && doc?.accessHash && doc?.fileReference) {
            const ref = `${doc.id}:${doc.accessHash}:${Buffer.from(doc.fileReference).toString("hex")}`;
            setCachedFileId(cacheKey, cacheType, 0, ref);
          }
        };

        if (fmt.sizeBytes > 0) {
          // Stream via named pipe — no disk write
          const pipePath = `${tmpdir()}/yt_pipe_${Date.now()}`;
          await mkfifo(pipePath);
          const dlProc = spawn(YT_DLP, ["-f", fmt.formatId, "--no-playlist", "-o", pipePath, url]);
          dlProc.stderr.on("data", () => {});
          try {
            await sendAndCache(new CustomFile(`${title}.mp4`, fmt.sizeBytes, pipePath));
          }
          finally {
            dlProc.kill();
            await unlink(pipePath).catch(() => {});
          }
        }
        else {
          // Fallback: write to disk (size unknown, can't use pipe)
          const tmpPath = `${tmpdir()}/yt_${Date.now()}.mp4`;
          const dlStream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
          const writer = createWriteStream(tmpPath);
          await new Promise<void>((res, rej) => {
            dlStream.pipe(writer);
            writer.on("finish", res);
            writer.on("error", rej);
          });
          try {
            await sendAndCache(tmpPath);
          }
          finally {
            await unlink(tmpPath).catch(() => {});
          }
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
        const dlStream = ytDlpStream(["-f", fmt.formatId, "--no-playlist", "-o", "-", url]);
        const rnd = Math.floor(Math.random() * 100000) + 1;
        const fname = `video_${new Date().toISOString().slice(0, 10)}_${rnd}.mp4`;
        const msg = await grammyApi.sendVideo(chatId, new InputFile(dlStream, fname), {
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
