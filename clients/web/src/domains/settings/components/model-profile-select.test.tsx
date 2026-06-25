import { describe, expect, mock, test } from "bun:test";

mock.module("@vellumai/design-library/components/dropdown", () => ({
  Dropdown: () => null,
}));

const { dropdownValueToProfileOption, profileOptionToDropdownValue } =
  await import("./model-profile-select");

describe("ModelProfileSelect", () => {
  test("maps null to a non-empty dropdown value", () => {
    expect(profileOptionToDropdownValue(null)).toBe("__default_profile__");
    expect(profileOptionToDropdownValue("fast")).toBe("fast");
  });

  test("maps the Default dropdown value back to null", () => {
    expect(dropdownValueToProfileOption("__default_profile__")).toBeNull();
    expect(dropdownValueToProfileOption("fast")).toBe("fast");
  });
});
