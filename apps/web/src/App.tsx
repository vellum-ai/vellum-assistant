import { Link, Outlet } from 'react-router';

export function App() {
  return (
    <div>
      <header>
        <h1>vellum-assistant · apps/web</h1>
        <nav>
          <Link to="/conversations/new">New conversation</Link>
          {' · '}
          <Link to="/library">Library</Link>
          {' · '}
          <Link to="/settings/general">Settings</Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
