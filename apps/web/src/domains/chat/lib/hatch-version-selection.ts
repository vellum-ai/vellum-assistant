export interface HatchVersionSelectorAccess {
  isDevOrStaging: boolean;
  isVellumStaff: boolean;
}

export function isVellumStaffUser(
  email: string | null,
  isStaff: boolean,
): boolean {
  if (isStaff) {
    return true;
  }

  return !!email && email.trim().toLowerCase().endsWith("@vellum.ai");
}

export function shouldShowHatchVersionSelector({
  isDevOrStaging,
  isVellumStaff,
}: HatchVersionSelectorAccess): boolean {
  return isDevOrStaging && isVellumStaff;
}
