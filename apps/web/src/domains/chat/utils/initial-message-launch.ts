
export const INITIAL_MESSAGE_SESSION_KEY = "vellum.assistant.initialMessage";

function getSessionStorage(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function storePendingInitialMessage(message: string): void {
  try {
    getSessionStorage()?.setItem(INITIAL_MESSAGE_SESSION_KEY, message);
  } catch {
    // Storage may be disabled or full; callers still navigate normally.
  }
}

export function consumePendingInitialMessage(): string | null {
  const storage = getSessionStorage();
  if (!storage) return null;

  try {
    const message = storage.getItem(INITIAL_MESSAGE_SESSION_KEY);
    storage.removeItem(INITIAL_MESSAGE_SESSION_KEY);
    return message;
  } catch {
    return null;
  }
}
