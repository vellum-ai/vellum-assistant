import { appPermanentRedirect } from "@/adapters/app-redirect.js";
import { routes } from "@/lib/routes.js";

/**
 * System Events moved out of Settings and into the Logs & Usage page.
 * Keep this route as a permanent redirect so existing bookmarks and
 * shared links continue to reach the same view.
 */
export default function SystemEventsSettingsRedirect() {
  appPermanentRedirect(routes.logs.systemEvents);
}
