/**
 * Whether the "Let's start with you" details have enough signal to run the
 * behind-the-scenes research turn. Role and hobbies are the only inputs that
 * turn a name into a searchable person; an empty pair is not worth a network
 * round-trip or the "Searching about you" wait.
 */

export function shouldSkipOnboardingResearch(values: {
  role: string;
  hobbies: readonly string[];
}): boolean {
  const roleEmpty = values.role.trim().length === 0;
  const hobbiesEmpty = values.hobbies.every(
    (hobby) => hobby.trim().length === 0,
  );
  return roleEmpty && hobbiesEmpty;
}
