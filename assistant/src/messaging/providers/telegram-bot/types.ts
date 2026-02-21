/** Telegram Bot API types used by the messaging provider. */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramGetMeResponse {
  ok: boolean;
  result?: TelegramUser;
  description?: string;
}
