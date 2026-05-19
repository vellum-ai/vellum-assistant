import { appRedirect } from "@/adapters/app-redirect.js";
import { routes } from "@/lib/routes.js";

export default function DangerZoneRedirectPage() {
  appRedirect(routes.settings.general);
}
