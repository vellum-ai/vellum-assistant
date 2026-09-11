import { resolveNotificationAvatarPath } from "./notification-avatar-path";
import type { NotificationCreateOptions } from "./notifications";

/** The `notifications/show` params a native helper toast is posted with. */
export interface HelperToastRequest {
  token: string;
  title: string;
  body: string;
  actions: { text: string }[];
  subtitle?: string;
  avatarPath?: string;
}

/**
 * With the avatar staged on disk the assistant is the sender, so its name is
 * the toast title, the conversation title drops to the subtitle, and the
 * picture travels as a path the helper reads. Without a sender, or when the
 * avatar could not be staged, the toast keeps the conversation title and
 * carries neither, which is each helper's plain app-icon layout.
 */
export const buildHelperToastRequest = (
  options: NotificationCreateOptions,
  context: {
    token: string;
    userDataDir: string;
    logger: { warn: (...args: unknown[]) => void };
  },
): HelperToastRequest => {
  const { token, userDataDir, logger } = context;
  const actions = options.actions.map((action) => ({ text: action.text }));
  const avatarPath = resolveNotificationAvatarPath(
    options.sender,
    userDataDir,
    logger,
  );
  if (options.sender && avatarPath) {
    return {
      token,
      title: options.sender.name,
      subtitle: options.title,
      body: options.body,
      actions,
      avatarPath,
    };
  }
  return { token, title: options.title, body: options.body, actions };
};
