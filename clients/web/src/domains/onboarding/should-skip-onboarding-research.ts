/**
 * Whether the "Let's start with you" details have enough signal to run the
 * behind-the-scenes research turn. A last name is required to tell people
 * apart; role and hobbies are the other searchable inputs. Missing last name,
 * or an empty role+hobbies pair, is not worth a network round-trip or the
 * "Searching about you" wait. There is no email-lookup fallback.
 */

export function shouldSkipOnboardingResearch(values: {
  lastName: string;
  role: string;
  hobbies: readonly string[];
}): boolean {
  const lastNameEmpty = values.lastName.trim().length === 0;
  const roleEmpty = values.role.trim().length === 0;
  const hobbiesEmpty = values.hobbies.every(
    (hobby) => hobby.trim().length === 0,
  );
  return lastNameEmpty || (roleEmpty && hobbiesEmpty);
}
