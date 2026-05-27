import { Link } from "react-router";

import { routes } from "@/utils/routes";

export function NotFound() {
  return (
    <section>
      <h2>Not found</h2>
      <p>
        The page you requested does not exist. <Link to={routes.assistant}>Start a new conversation</Link>.
      </p>
    </section>
  );
}
