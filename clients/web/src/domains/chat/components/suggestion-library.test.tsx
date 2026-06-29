/**
 * Tests for `SuggestionLibrary`.
 *
 * Covers: rendering the featured row cards, the "Scroll down to see more"
 * affordance, each group's title heading and its cards, and that selecting a
 * card forwards the suggestion to the library's `onSelect`. Fixtures use
 * distinct titles so title assertions stay unambiguous.
 */

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { SuggestionLibrary } from "@/domains/chat/components/suggestion-library";
import type {
  SuggestionGroup,
  ThreadSuggestion,
} from "@/domains/chat/suggestions/types";

afterEach(() => {
  cleanup();
});

function makeSuggestion(id: string, title: string): ThreadSuggestion {
  return {
    id,
    title,
    iconKey: "generic",
    prompt: `Do ${title}.`,
    detail: {
      heading: title,
      description: `About ${title}.`,
      requirements: [],
      capabilities: [],
    },
  };
}

const featured: ThreadSuggestion[] = [
  makeSuggestion("featured-1", "Featured One"),
  makeSuggestion("featured-2", "Featured Two"),
];

const groups: SuggestionGroup[] = [
  {
    id: "your-plugins",
    title: "Your plugins",
    source: "plugin",
    suggestions: [
      makeSuggestion("group-1", "Group One"),
      makeSuggestion("group-2", "Group Two"),
      makeSuggestion("group-3", "Group Three"),
    ],
  },
];

test("renders the featured cards", () => {
  const { getByText } = render(
    <SuggestionLibrary
      featured={featured}
      groups={groups}
      onSelect={() => {}}
    />,
  );

  expect(getByText("Featured One")).not.toBeNull();
  expect(getByText("Featured Two")).not.toBeNull();
});

test("renders the scroll affordance", () => {
  const { getByText } = render(
    <SuggestionLibrary
      featured={featured}
      groups={groups}
      onSelect={() => {}}
    />,
  );

  expect(getByText("Scroll down to see more")).not.toBeNull();
});

test("renders each group title and its cards", () => {
  const { getByText } = render(
    <SuggestionLibrary
      featured={featured}
      groups={groups}
      onSelect={() => {}}
    />,
  );

  expect(getByText("Your plugins")).not.toBeNull();
  expect(getByText("Group One")).not.toBeNull();
  expect(getByText("Group Two")).not.toBeNull();
  expect(getByText("Group Three")).not.toBeNull();
});

test("forwards onSelect with the suggestion when a card is clicked", () => {
  const onSelect = mock((_: ThreadSuggestion) => {});
  const { getByText } = render(
    <SuggestionLibrary featured={featured} groups={groups} onSelect={onSelect} />,
  );

  fireEvent.click(getByText("Group Two"));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith(groups[0].suggestions[1]);
});
