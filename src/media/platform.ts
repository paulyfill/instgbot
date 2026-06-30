export const isYoutubeShortsLink = (url: string): boolean => {
  return url.includes("youtube.com/shorts/");
};

export const isYoutubeLink = (url: string): boolean => {
  return url.includes("youtube.com/") || url.includes("youtu.be/");
};

export const isThreadsLink = (url: string): boolean => {
  return url.includes("threads.com");
};

export const isTelegramLink = (url: string): boolean => {
  return /https?:\/\/t\.me\/[A-Za-z0-9_]/.test(url);
};

export type TelegramLinkInfo =
  | { type: "story", username: string, id: number }
  | { type: "post", username: string, id: number }
  | { type: "private_post", channelId: bigint, messageId: number }
  | { type: "stories_all", username: string };

export const parseTelegramLink = (url: string): TelegramLinkInfo | null => {
  // https://t.me/c/1724666497/5083 — приватный канал
  const privateMatch = url.match(/t\.me\/c\/(\d+)\/(\d+)/);
  if (privateMatch) return { type: "private_post", channelId: BigInt(`-100${privateMatch[1]}`), messageId: +privateMatch[2] };

  // https://t.me/username/s/300 — конкретная сторис
  const storyMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/s\/(\d+)/);
  if (storyMatch) return { type: "story", username: storyMatch[1], id: +storyMatch[2] };

  // https://t.me/username/300 — пост в канале
  const postMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/(\d+)/);
  if (postMatch) return { type: "post", username: postMatch[1], id: +postMatch[2] };

  // https://t.me/username — все сторис
  const usernameMatch = url.match(/t\.me\/([A-Za-z0-9_]+)\/?$/);
  if (usernameMatch) return { type: "stories_all", username: usernameMatch[1] };

  return null;
};

export const detectPlatform = (url: string): string => {
  if (url.includes("tiktok.com")) return "tiktok";
  if (url.includes("instagram.com")) return "instagram";
  if (url.includes("facebook.com") || url.includes("fb.com")) return "facebook";
  if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("threads.com")) return "threads";
  if (url.startsWith("@") || url.includes("t.me/")) return "telegram";
  return "unknown";
};
