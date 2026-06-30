import TelegramBot from "node-telegram-bot-api";
import {
  getAllUsers,
  getNewsletterStats,
  getPlatformStats,
  getRecentErrors,
  getStats,
  getTopUsers,
  getUsers
} from "../db/queries";
import { ADMIN_USER_IDS, BOT_TAG, isAdmin } from "../config";
import { safeSendMessage } from "../bot/safe-send";
import { splitMessage } from "../utils/messages";

// Admin commands handler
export const handleAdminCommands = async (
  bot: TelegramBot,
  chatId: number,
  message: string,
  userId?: number
): Promise<boolean> => {
  if (!isAdmin(userId)) return false;

  const [command, ...args] = message.split(" ");

  switch (command.toLowerCase()) {
    case "/users":
      await handleUsersCommand(bot, chatId, args);
      return true;
    case "/stats":
      await handleStatsCommand(bot, chatId);
      return true;
    case "/top":
      await handleTopUsersCommand(bot, chatId, args);
      return true;
    case "/errors":
      await handleErrorsCommand(bot, chatId, args);
      return true;
    case "/platforms":
      await handlePlatformsCommand(bot, chatId);
      return true;
    case "/announcecount":
      await handleAnnouncementCountCommand(bot, chatId);
      return true;
    case "/ah":
      await handleAdminHelpCommand(bot, chatId);
      return true;
    case "/announce":
      await handleAnnouncementCommand(bot, chatId, message);
      return true;
    default:
      return false;
  }
};

const handleUsersCommand = async (bot: TelegramBot, chatId: number, args: string[]) => {
  try {
    const limit = args[0] ? parseInt(args[0]) : 20;
    const users = getUsers(limit);

    if (users.length === 0) {
      await safeSendMessage(bot, chatId, "📭 Пользователей пока нет");
      return;
    }

    let message = `👥 Статистика пользователей (показано ${users.length}):\n\n`;

    users.forEach((user, index) => {
      const username = user.username ? `@${user.username}` : user.first_name || "Без имени";
      const lastActivity = new Date(user.last_activity).toLocaleString("ru-RU");

      message += `${index + 1}. ${username}\n`;
      message += `   📊 Скачивания: ${user.download_count}\n`;
      message += `   ❌ Ошибки: ${user.error_count}\n`;
      message += `   🕐 Последняя активность: ${lastActivity}\n`;
      message += `   🆔 ID: ${user.chat_id}\n\n`;
    });

    const chunks = splitMessage(message);

    for (const chunk of chunks) {
      await safeSendMessage(bot, chatId, chunk);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, `❌ Ошибка при получении пользователей: ${error}`);
  }
};

const handleStatsCommand = async (bot: TelegramBot, chatId: number) => {
  try {
    const stats = getStats();

    const message = [
      "📊 Общая статистика бота:",
      "",
      `👥 Всего пользователей: ${stats.totalUsers}`,
      `📱 Активных за 24ч: ${stats.activeUsers24h}`,
      `✅ Успешных скачиваний: ${stats.totalDownloads}`,
      `❌ Всего ошибок: ${stats.totalErrors}`,
      "",
      `⏰ Обновлено: ${new Date().toLocaleString("ru-RU")}`
    ].join("\n");

    await safeSendMessage(bot, chatId, message);
  }
  catch (error) {
    await safeSendMessage(bot, chatId, `❌ Ошибка при получении статистики: ${error}`);
  }
};

const handleTopUsersCommand = async (bot: TelegramBot, chatId: number, args: string[]) => {
  try {
    const limit = args[0] ? parseInt(args[0]) : 10;
    const topUsers = getTopUsers(limit);

    if (topUsers.length === 0) {
      await safeSendMessage(bot, chatId, "📭 Активных пользователей пока нет");
      return;
    }

    let message = `🏆 ТОП-${topUsers.length} пользователей по скачиваниям:\n\n`;

    topUsers.forEach((user, index) => {
      const username = user.username ? `@${user.username}` : user.first_name || "Без имени";
      const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;

      message += `${medal} ${username}\n`;
      message += `   📊 ${user.download_count} скачиваний\n`;
      message += `   🆔 ID: ${user.chat_id}\n\n`;
    });

    const chunks = splitMessage(message);

    for (const chunk of chunks) {
      await safeSendMessage(bot, chatId, chunk);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, `❌ Ошибка при получении топа: ${error}`);
  }
};

const handleErrorsCommand = async (bot: TelegramBot, chatId: number, args: string[]) => {
  try {
    const limit = args[0] ? parseInt(args[0]) : 5;
    const errors = getRecentErrors(limit);

    if (errors.length === 0) {
      await safeSendMessage(bot, chatId, "✅ Недавних ошибок нет");
      return;
    }

    let message = `🚨 Последние ${errors.length} ошибок:\n\n`;

    errors.forEach((error, index) => {
      const username = error.username ? `@${error.username}` : error.first_name || "Без имени";
      const timestamp = new Date(error.timestamp).toLocaleString("ru-RU");

      message += `${index + 1}. ${username} (ID: ${error.chat_id})\n`;
      message += `   🏷️ Контекст: ${error.error_context}\n`;
      message += `   💬 Сообщение: ${error.original_message || "Не указано"}\n`;
      message += `   ⚠️ Ошибка: ${error.error_message.substring(0, 100)}${error.error_message.length > 100 ? "..." : ""}\n`;
      message += `   🕐 Время: ${timestamp}\n\n`;
    });

    const chunks = splitMessage(message);

    for (const chunk of chunks) {
      await safeSendMessage(bot, chatId, chunk);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, `❌ Ошибка при получении ошибок: ${error}`);
  }
};

const handlePlatformsCommand = async (bot: TelegramBot, chatId: number) => {
  try {
    const platforms = getPlatformStats();

    if (platforms.length === 0) {
      await safeSendMessage(bot, chatId, "📊 Статистика платформ пока пуста");
      return;
    }

    let message = "📱 Статистика по платформам:\n\n";

    platforms.forEach(platform => {
      message += `🌐 ${platform.platform.toUpperCase()}\n`;
      message += `   📊 Всего запросов: ${platform.total_requests}\n`;
      message += `   ✅ Успешных: ${platform.successful_downloads}\n`;
      message += `   📈 Процент успеха: ${platform.success_rate}%\n\n`;
    });

    const chunks = splitMessage(message);

    for (const chunk of chunks) {
      await safeSendMessage(bot, chatId, chunk);
    }
  }
  catch (error) {
    await safeSendMessage(bot, chatId, `❌ Ошибка при получении статистики платформ: ${error}`);
  }
};

const handleAnnouncementCountCommand = async (bot: TelegramBot, chatId: number) => {
  try {
    const newsletterStats = getNewsletterStats();

    const reportMessage = [
      "📊 Статистика подписок на рассылку:",
      "",
      `👥 Всего пользователей в базе: ${newsletterStats.total}`,
      `🔔 Подписаны на рассылку: ${newsletterStats.subscribed}`,
      `🔕 Отписались от рассылки: ${newsletterStats.unsubscribed}`,
      "",
      `📈 Процент подписчиков: ${newsletterStats.total > 0 ? Math.round((newsletterStats.subscribed / newsletterStats.total) * 100) : 0}%`,
      "",
      `⏰ Проверено: ${new Date().toLocaleString("ru-RU")}`
    ].join("\n");

    await safeSendMessage(bot, chatId, reportMessage);
  }
  catch (error) {
    console.error("Newsletter count error:", error);
    await safeSendMessage(bot, chatId, "Произошла ошибка при получении статистики подписок.");
  }
};

const handleAdminHelpCommand = async (bot: TelegramBot, chatId: number) => {
  const message = [
    "🔧 Админские команды:",
    "",
    "👤 /users [количество] - список пользователей",
    "📊 /stats - общая статистика",
    "🏆 /top [количество] - топ пользователей",
    "🚨 /errors [количество] - последние ошибки",
    "📱 /platforms - статистика по платформам",
    "📢 /announce [сообщение] - отправить объявление подписанным пользователям",
    "📈 /announceCount - статистика подписок на рассылку",
    "❓ /ah - эта справка",
    "",
    "Примеры:",
    "• /users 10 - показать 10 пользователей",
    "• /top 5 - топ 5 пользователей",
    "• /errors 3 - последние 3 ошибки",
    "",
    "ℹ️ Рассылка отправляется только пользователям с включенной подпиской (/newsletter)"
  ].join("\n");

  await safeSendMessage(bot, chatId, message);
};

const handleAnnouncementCommand = async (bot: TelegramBot, chatId: number, message: string) => {
  // Extract announcement text after /announce command
  const announcementText = message.replace(/^\/announce\s*/, "").trim();

  if (!announcementText) {
    await safeSendMessage(bot, chatId, "Пожалуйста, добавьте текст объявления после команды /announce\n\nПример: /announce Сегодня мы добавили новую функцию!");
    return;
  }

  // Format the announcement message
  const formattedMessage = `${announcementText}\n\n📢 Отписаться от рассылки: /newsletter\n\n${BOT_TAG}`;

  // Get all users from database
  const users = getAllUsers();

  if (users.length === 0) {
    await safeSendMessage(bot, chatId, "В базе данных нет пользователей для отправки объявления.");
    return;
  }

  // Send confirmation to admin
  await safeSendMessage(bot, chatId, `Начинаю отправку объявления ${users.length} пользователям...\n\nТекст объявления:\n${formattedMessage}`);

  let successCount = 0;
  let failureCount = 0;
  const failedUsers: number[] = [];

  const batchSize = 10;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(batch.map(async (user) => {
      try {
        const result = await safeSendMessage(bot, user.chat_id, formattedMessage, {
          disable_notification: true
        });
        if (result !== null) {
          successCount++;
        }
        else {
          failureCount++;
          failedUsers.push(user.chat_id);
        }
      }
      catch (error) {
        failureCount++;
        failedUsers.push(user.chat_id);
        console.error(`Failed to send announcement to user ${user.chat_id}:`, error);
      }
    }));
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Send report to admin
  const newsletterStats = getNewsletterStats();
  const reportMessage = [
    "📢 Объявление отправлено!",
    "",
    "� Статистика рассылки:",
    `✅ Успешно доставлено: ${successCount}`,
    `❌ Не удалось доставить: ${failureCount}`,
    `📤 Отправлено подписанным: ${users.length}`,
    "",
    "👥 Общая статистика пользователей:",
    `📈 Всего пользователей: ${newsletterStats.total}`,
    `🔔 Подписаны на рассылку: ${newsletterStats.subscribed}`,
    `🔕 Отписаны от рассылки: ${newsletterStats.unsubscribed}`,
    "",
    failureCount > 0 ? `❌ Не удалось доставить пользователям: ${failedUsers.slice(0, 10).join(", ")}${failedUsers.length > 10 ? ` и еще ${failedUsers.length - 10}...` : ""}` : "🎉 Все объявления доставлены успешно!"
  ].join("\n");

  await safeSendMessage(bot, chatId, reportMessage);
};
