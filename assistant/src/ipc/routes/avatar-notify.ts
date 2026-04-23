import type { IpcRoute } from "../cli-server.js";

export const avatarNotifyRoute: IpcRoute = {
  method: "notify_avatar_updated",
  handler: async () => {
    const { publishAvatarUpdated } =
      await import("../../runtime/routes/avatar-routes.js");
    publishAvatarUpdated();
    return { ok: true };
  },
};
