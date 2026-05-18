import { Link } from "react-router";

export function NotFound() {
  return (
    <section>
      <h2>Not found</h2>
      <p>
        The page you requested does not exist. <Link to="/">Start a new conversation</Link>.
      </p>
    </section>
  );
}
