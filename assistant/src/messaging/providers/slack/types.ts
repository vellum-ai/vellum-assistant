/** Slack Web API response types. */

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

export interface SlackConversation {
  id: string;
  name?: string;
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
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users: string[] }>;
  files?: Array<{ id: string; name: string; mimetype: string }>;
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
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
    image_48?: string;
  };
  is_bot?: boolean;
  deleted?: boolean;
}

export interface SlackUsersListResponse extends SlackApiResponse {
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
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

export interface SlackConversationInfoResponse extends SlackApiResponse {
  channel: SlackConversation;
}

export interface SlackConversationsOpenResponse extends SlackApiResponse {
  channel: { id: string };
}

export type SlackReactionAddResponse = SlackApiResponse;

export type SlackConversationJoinResponse = SlackApiResponse & {
  channel?: SlackConversation;
};

export type SlackConversationLeaveResponse = SlackApiResponse;

export interface SlackChatDeleteResponse extends SlackApiResponse {
  channel: string;
  ts: string;
}

export interface SlackChatUpdateResponse extends SlackApiResponse {
  channel: string;
  ts: string;
  text: string;
}

export type SlackConversationMarkResponse = SlackApiResponse;

export interface SlackPostEphemeralResponse extends SlackApiResponse {
  message_ts: string;
}
