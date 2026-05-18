import { useParams } from "react-router";

export function LibraryDetailPage() {
  const { appId } = useParams<{ appId: string }>();
  return (
    <section>
      <h2>Library item</h2>
      <p>
        Placeholder for library item <code>{appId}</code>.
      </p>
    </section>
  );
}
