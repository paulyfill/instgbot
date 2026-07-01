import TelegramBot from "node-telegram-bot-api";
import { isAdmin } from "../config";
import { safeSendMessage } from "./safe-send";

type UserRateLimit = {
  requests: number[];
  lastCleanup: number;
};

type RateLimitResult = {
  allowed: boolean;
  remainingRequests: number;
  resetTime: number;
};

const userRateLimits = new Map<number, UserRateLimit>();
const RATE_LIMIT_REQUESTS = 5; // Максимум запросов
const RATE_LIMIT_WINDOW = 60 * 1000; // Окно в 1 минуту (мс)

// Функция проверки rate limit
export const checkRateLimit = (userId: number): RateLimitResult => {
  const now = Date.now();

  // Получаем или создаем данные пользователя
  let userLimit = userRateLimits.get(userId);
  if (!userLimit) {
    userLimit = { requests: [], lastCleanup: now };
    userRateLimits.set(userId, userLimit);
  }

  // Очищаем старые запросы (старше 1 минуты)
  userLimit.requests = userLimit.requests.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW
  );

  if (userLimit.requests.length >= RATE_LIMIT_REQUESTS) {
    const oldestRequest = Math.min(...userLimit.requests);
    const resetTime = oldestRequest + RATE_LIMIT_WINDOW;
    return {
      allowed: false,
      remainingRequests: 0,
      resetTime
    };
  }

  userLimit.requests.push(now);

  return {
    allowed: true,
    remainingRequests: RATE_LIMIT_REQUESTS - userLimit.requests.length,
    resetTime: now + RATE_LIMIT_WINDOW
  };
};

const tgStoriesRateLimits = new Map<number, number>(); // userId -> timestamp последнего запроса
const TG_STORIES_LIMIT_WINDOW = 3 * 60 * 1000; // 3 минуты

export const checkTelegramStoriesRateLimit = (userId: number): { allowed: boolean, resetTime: number } => {
  if (isAdmin(userId)) return { allowed: true, resetTime: 0 };
  const now = Date.now();
  const lastRequest = tgStoriesRateLimits.get(userId) || 0;
  if (now - lastRequest < TG_STORIES_LIMIT_WINDOW) {
    return {
      allowed: false,
      resetTime: lastRequest + TG_STORIES_LIMIT_WINDOW
    };
  }
  tgStoriesRateLimits.set(userId, now);
  return { allowed: true, resetTime: now + TG_STORIES_LIMIT_WINDOW };
};

const ytRateLimits = new Map<number, number>();
const YT_LIMIT_WINDOW = 3 * 60 * 1000;

export const checkYouTubeRateLimit = (userId: number): { allowed: boolean, resetTime: number } => {
  if (isAdmin(userId)) return { allowed: true, resetTime: 0 };
  const now = Date.now();
  const last = ytRateLimits.get(userId) ?? 0;
  if (now - last < YT_LIMIT_WINDOW) return { allowed: false, resetTime: last + YT_LIMIT_WINDOW };
  ytRateLimits.set(userId, now);
  return { allowed: true, resetTime: 0 };
};

export const cleanupRateLimitData = () => {
  const now = Date.now();
  for (const [userId, userLimit] of userRateLimits.entries()) {
    if (now - userLimit.lastCleanup > 5 * 60 * 1000) {
      userRateLimits.delete(userId);
    }
  }
};

export const cleanupTelegramStoriesRateLimit = () => {
  const now = Date.now();
  for (const [userId, lastRequest] of tgStoriesRateLimits.entries()) {
    if (now - lastRequest > TG_STORIES_LIMIT_WINDOW) {
      tgStoriesRateLimits.delete(userId);
    }
  }
};
setInterval(() => {
  cleanupTelegramStoriesRateLimit();
  cleanupRateLimitData();
}, 5 * 60 * 1000);

// Функция для отправки сообщения о превышении лимита
export const sendRateLimitMessage = async (
  bot: TelegramBot,
  chatId: number,
  resetTime: number
): Promise<void> => {
  const resetDate = new Date(resetTime);
  const now = new Date();
  const minutesLeft = Math.ceil((resetTime - now.getTime()) / (60 * 1000));

  const message = [
    "⚠️ Превышен лимит запросов",
    "",
    `Вы можете отправлять максимум ${RATE_LIMIT_REQUESTS} запросов в минуту.`,
    `Попробуйте снова через ${minutesLeft} минут${
      minutesLeft === 1 ? "у" : minutesLeft < 5 ? "ы" : ""
    }.`,
    "",
    "Это ограничение помогает поддерживать стабильную работу бота для всех пользователей. 🤖"
  ].join("\n");

  await safeSendMessage(bot, chatId, message);
};
