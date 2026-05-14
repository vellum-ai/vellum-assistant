import { useParams } from 'react-router';

export function LibraryDetail() {
  const { slug } = useParams<{ slug: string }>();
  return (
    <section>
      <h2>Library item</h2>
      <p>
        Placeholder for library item <code>{slug}</code>.
      </p>
    </section>
  );
}
