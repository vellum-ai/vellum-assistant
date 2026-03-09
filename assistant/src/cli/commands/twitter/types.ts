/**
 * Public types shared across the Twitter CLI module.
 * Extracted from the former browser CDP client.
 */

export interface PostTweetResult {
  tweetId: string;
  text: string;
  url: string;
}

export interface UserInfo {
  userId: string;
  screenName: string;
  name: string;
}

export interface TweetEntry {
  tweetId: string;
  text: string;
  url: string;
  createdAt: string;
}

export interface NotificationEntry {
  id: string;
  message: string;
  timestamp: string;
  url?: string;
}
