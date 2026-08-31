/** Slack Web API response types. */

import type {
  AnyBlock,
  GenericMessageEvent,
  MessageAttachment,
} from "@slack/types";

export interface SlackApiResponse {
  ok: boolean;
  error?: string;
}

export interface SlackAuthTestResponse extends SlackApiResponse {
  url: string;
  team: string;
  user: string;
  team_id: string;
  user_id: string;
}

export interface SlackBotsInfoResponse extends SlackApiResponse {
  bot: {
    id: string;
    user_id?: string;
    app_id?: string;
    name?: string;
    deleted?: boolean;
    updated?: number;
  };
}

export interface SlackConversation {
  id: string;
  name?: string;
  name_normalized?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
  unread_count?: number;
  unread_count_display?: number;
  latest?: SlackMessage;
  user?: string;
  /** IM rows only: the DM peer's account has been deactivated. */
  is_user_deleted?: boolean;
}

export interface SlackConversationInfoResponse extends SlackApiResponse {
  channel: SlackConversation;
}

export interface SlackConversationsListResponse extends SlackApiResponse {
  channels: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  ts: string;
  user?: string;
  bot_id?: string;
  /**
   * Display name for `bot_message`-subtype rows (incoming webhooks and
   * legacy bot posts, which carry no `user` to resolve a name from).
   */
  username?: string;
  /** Profile of the posting app, attached to bot-authored rows. The type is
   *  indexed off the official message event because `@slack/types` does not
   *  export `BotProfile` from its root. */
  bot_profile?: GenericMessageEvent["bot_profile"];
  text: string;
  /**
   * Bot/webhook posts routinely leave `text` empty and put the visible
   * content here or in `blocks`; see `slackMessageRawText`.
   */
  attachments?: MessageAttachment[];
  blocks?: AnyBlock[];
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users: string[] }>;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    /** Slack-hosted download URL requiring bot-token auth. Present on
     * real `conversations.replies` / `conversations.history` responses;
     * downloaders prefer this over `url_private`. */
    url_private_download?: string;
    /** Slack-hosted file URL requiring bot-token auth. Fallback for
     * downloaders when `url_private_download` is absent. */
    url_private?: string;
    size?: number;
  }>;
}

export interface SlackConversationHistoryResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationRepliesResponse extends SlackApiResponse {
  messages: SlackMessage[];
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  tz?: string;
  tz_label?: string;
  tz_offset?: number;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    image_48?: string;
  };
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackUserInfoResponse extends SlackApiResponse {
  user: SlackUser;
}

export interface SlackPostMessageResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  message: SlackMessage;
}

export interface SlackSearchMessagesResponse extends SlackApiResponse {
  messages: {
    total: number;
    matches: SlackSearchMatch[];
    paging: { count: number; total: number; page: number; pages: number };
  };
}

export interface SlackSearchMatch {
  iid: string;
  ts: string;
  text: string;
  user?: string;
  username?: string;
  channel: { id: string; name: string };
  permalink: string;
  thread_ts?: string;
}

export interface SlackConversationsOpenResponse extends SlackApiResponse {
  channel: { id: string };
}

export type SlackConversationMarkResponse = SlackApiResponse;

export interface SlackUsersListResponse extends SlackApiResponse {
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
}
