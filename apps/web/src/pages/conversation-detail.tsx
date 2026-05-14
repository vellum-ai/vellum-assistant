import { useParams } from 'react-router';

export function ConversationDetail() {
  const { id } = useParams<{ id: string }>();
  return (
    <section>
      <h2>Conversation</h2>
      <p>
        Placeholder for conversation <code>{id}</code>.
      </p>
    </section>
  );
}
