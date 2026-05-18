import { useParams } from "react-router";

export function SettingsTabPage() {
  const { tab } = useParams<{ tab: string }>();
  return (
    <section>
      <h2>Settings</h2>
      <p>
        Placeholder for settings tab <code>{tab}</code>.
      </p>
    </section>
  );
}
