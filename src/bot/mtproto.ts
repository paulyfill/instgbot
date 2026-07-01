import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";

// Bot MTProto client — supports files up to 2GB unlike HTTP Bot API (50MB)
const botMtproto = new TelegramClient(
  new StringSession(""),
  +Bun.env.TELEGRAM_API_ID!,
  Bun.env.TELEGRAM_API_HASH!,
  { connectionRetries: 5 }
);

let started = false;

export const getBotMtproto = async () => {
  if (!started) {
    await botMtproto.start({ botAuthToken: Bun.env.TELEGRAM_BOT! });
    started = true;
  }
  return botMtproto;
};
