export const BOT_TAG = "@instg_save_bot";
export const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME!;
export const ADMIN_USER_IDS = [324025710, 542142955];
export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return ADMIN_USER_IDS.includes(userId);
};
