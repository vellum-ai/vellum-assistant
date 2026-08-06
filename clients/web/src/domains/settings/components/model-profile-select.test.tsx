import { describe, expect, mock, test } from "bun:test";

mock.module("@vellumai/design-library/components/select", () => ({
  Select: () => null,
}));

const { selectValueToProfileOption, profileOptionToSelectValue } = await import(
  "./model-profile-select"
);

describe("ModelProfileSelect", () => {
  test("maps null to a non-empty select value", () => {
    expect(profileOptionToSelectValue(null)).toBe("__default_profile__");
    expect(profileOptionToSelectValue("fast")).toBe("fast");
  });

  test("maps the Default dropdown value back to null", () => {
    expect(selectValueToProfileOption("__default_profile__")).toBeNull();
    expect(selectValueToProfileOption("fast")).toBe("fast");
  });
});
