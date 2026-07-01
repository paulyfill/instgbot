import { db } from "./schema";

export const upsertUser = (chatId: number, username?: string, firstName?: string): number => {
  const now = new Date().toISOString();

  try {
    const existing = db.query("SELECT id FROM users WHERE chat_id = ?").get(chatId) as { id: number } | undefined;
    if (existing?.id) {
      db.query("UPDATE users SET username = ?, first_name = ?, last_activity = ? WHERE chat_id = ?")
        .run(username || null, firstName || null, now, chatId);
      return existing.id;
    }
    const result = db.query("INSERT INTO users (username, first_name, chat_id, first_seen, last_activity) VALUES (?, ?, ?, ?, ?)")
      .run(username || null, firstName || null, chatId, now, now);
    return Number(result.lastInsertRowid);
  }
  catch (error) {
    console.error("Database error in upsertUser:", { chatId, username, firstName, error });
    throw error;
  }
};

export const recordDownload = (chatId: number, url: string, platform: string, mediaType: string, success: boolean, username?: string, firstName?: string) => {
  try {
    const userId = upsertUser(chatId, username, firstName);
    const now = new Date().toISOString();

    db.query(`
      INSERT INTO downloads (user_id, url, platform, media_type, success, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, url, platform, mediaType, success, now);

    if (success) {
      db.query("UPDATE users SET download_count = download_count + 1 WHERE id = ?").run(userId);
    }
  }
  catch (error) {
    console.error("Database error in recordDownload:", error);
    console.error("Parameters:", { chatId, url, platform, mediaType, success, username, firstName });
  }
};

export const recordError = (chatId: number, errorContext: string, errorMessage: string, originalMessage?: string, username?: string, firstName?: string) => {
  try {
    const userId = upsertUser(chatId, username, firstName);
    const now = new Date().toISOString();

    db.query(`
      INSERT INTO errors (user_id, error_context, error_message, original_message, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, errorContext, errorMessage, originalMessage || null, now);

    db.query("UPDATE users SET error_count = error_count + 1 WHERE id = ?").run(userId);
  }
  catch (error) {
    console.error("Database error in recordError:", error);
    console.error("Parameters:", { chatId, errorContext, errorMessage, originalMessage, username, firstName });
  }
};

export const updateUserActivity = (chatId: number) => {
  try {
    const now = new Date().toISOString();
    db.query("UPDATE users SET last_activity = ? WHERE chat_id = ?").run(now, chatId);
  }
  catch (error) {
    console.error("Database error in updateUserActivity:", error);
    console.error("Parameters:", { chatId });
  }
};

export const getUsers = (limit: number) => {
  return db.query("SELECT * FROM users ORDER BY download_count DESC, last_activity DESC LIMIT ?").all(limit) as any[];
};

export const getStats = () => {
  const totalUsers = db.query("SELECT COUNT(*) as count FROM users").get() as { count: number };
  const totalDownloads = db.query("SELECT COUNT(*) as count FROM downloads WHERE success = 1").get() as { count: number };
  const totalErrors = db.query("SELECT COUNT(*) as count FROM errors").get() as { count: number };
  const activeUsers24h = db.query(`
    SELECT COUNT(*) as count FROM users
    WHERE datetime(last_activity) > datetime('now', '-24 hours')
  `).get() as { count: number };

  return {
    totalUsers: totalUsers.count,
    totalDownloads: totalDownloads.count,
    totalErrors: totalErrors.count,
    activeUsers24h: activeUsers24h.count
  };
};

export const getTopUsers = (limit: number) => {
  return db.query(`
    SELECT * FROM users
    WHERE download_count > 0
    ORDER BY download_count DESC
    LIMIT ?
  `).all(limit) as any[];
};

export const getRecentErrors = (limit: number) => {
  return db.query(`
    SELECT
      e.*,
      u.username,
      u.first_name,
      u.chat_id
    FROM errors e
    JOIN users u ON e.user_id = u.id
    ORDER BY e.timestamp DESC
    LIMIT ?
  `).all(limit) as any[];
};

export const getPlatformStats = () => {
  return db.query(`
    SELECT
      platform,
      COUNT(*) as total_requests,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_downloads,
      ROUND(
        (SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*)), 2
      ) as success_rate
    FROM downloads
    GROUP BY platform
    ORDER BY total_requests DESC
  `).all() as any[];
};

export const getAllUsers = (): Array<{ chat_id: number, username?: string, first_name?: string }> => {
  return db.prepare(`
    SELECT chat_id, username, first_name
    FROM users
    WHERE newsletter = 1
    ORDER BY last_activity DESC
  `).all() as Array<{ chat_id: number, username?: string, first_name?: string }>;
};

export const toggleNewsletterSubscription = (chatId: number): boolean => {
  const currentStatus = db.prepare(`
    SELECT newsletter FROM users WHERE chat_id = ?
  `).get(chatId) as { newsletter: number } | undefined;

  if (!currentStatus) {
    return false;
  }

  const newStatus = currentStatus.newsletter === 1 ? 0 : 1;

  db.prepare(`
    UPDATE users SET newsletter = ? WHERE chat_id = ?
  `).run(newStatus, chatId);

  return newStatus === 1;
};

export const getNewsletterStatus = (chatId: number): boolean => {
  const result = db.prepare(`
    SELECT newsletter FROM users WHERE chat_id = ?
  `).get(chatId) as { newsletter: number } | undefined;

  return result ? result.newsletter === 1 : true;
};

export const getNewsletterStats = (): { total: number, subscribed: number, unsubscribed: number } => {
  const result = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN newsletter = 1 THEN 1 ELSE 0 END) as subscribed,
      SUM(CASE WHEN newsletter = 0 THEN 1 ELSE 0 END) as unsubscribed
    FROM users
  `).get() as { total: number, subscribed: number, unsubscribed: number };

  return result || { total: 0, subscribed: 0, unsubscribed: 0 };
};

export const getCachedFileId = (postUrl: string, mediaType: string, index = 0): string | null => {
  const row = db.query("SELECT file_id FROM media_cache WHERE post_url = ? AND media_type = ? AND media_index = ?")
    .get(postUrl, mediaType, index) as { file_id: string } | undefined;
  return row?.file_id ?? null;
};

export const setCachedFileId = (postUrl: string, mediaType: string, index: number, fileId: string): void => {
  db.query("INSERT OR REPLACE INTO media_cache (post_url, media_type, media_index, file_id) VALUES (?, ?, ?, ?)")
    .run(postUrl, mediaType, index, fileId);
};
