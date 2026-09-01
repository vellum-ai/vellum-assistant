import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

import { routes } from "@/utils/routes";

/**
 * Forwards `/assistant/home` to the assistant root.
 *
 * The URL is a contract that bookmarks, saved deep links, and the login
 * `returnTo` round-trip all still name, so it resolves rather than falling
 * into the `/assistant/*` catch-all. Notifications live in the bell in the
 * chat chrome, which the root lands on.
 *
 * The query string and hash ride along, so a link carrying its own params
 * arrives with them intact and the replacement surface can read whatever it
 * understands.
 */
export function ActivityRedirectPage() {
  const navigate = useNavigate();
  const { search, hash } = useLocation();

  useEffect(() => {
    navigate(`${routes.assistant}${search}${hash}`, { replace: true });
  }, [navigate, search, hash]);

  return null;
}
