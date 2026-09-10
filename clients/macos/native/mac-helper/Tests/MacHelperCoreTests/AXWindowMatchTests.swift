import Testing

@testable import MacHelperCore

@Suite("AXWindowMatch")
struct AXWindowMatchTests {
    /// Stacked Chrome windows, all reporting the same frame, each titled by
    /// its page plus the suffix Chromium appends.
    private static let chrome = [
        "Weekly Planning / User Stories | Notes - Google Chrome - Alice (example.com)",
        "Example Assistant - Google Chrome - Alice",
        "Inbox (1) - user@example.com - Mail - Google Chrome - Alice (example.com)",
        "Quarterly Report - Google Chrome - Alice (example.com)",
    ]

    @Test("an app that appends its own suffix still resolves")
    func chromeSuffix() {
        // The real case: five Chrome windows stacked at one frame, each named
        // by its page plus Chrome's own suffix.
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Weekly Planning / User Stories | Notes",
                titles: Self.chrome,
                candidates: .sharingOneFrame
            ) == 0
        )
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Example Assistant",
                titles: Self.chrome,
                candidates: .sharingOneFrame
            ) == 1
        )
    }

    /**
     Which form an app gives a window is not knowable from this side, so among
     windows sharing a frame an exact title beside a decorated one is an
     ambiguity. The Chrome tab picker already answers it this way.
     */
    @Test("an exact title beside a decorated one at the same frame decides nothing")
    func exactBesideDecoratedAtOneFrame() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Doc",
                titles: ["Doc", "Doc - Preview"],
                candidates: .sharingOneFrame
            ) == nil
        )
    }

    @Test("an exact title still wins")
    func exactMatch() {
        #expect(AXWindowMatch.uniqueTitle(serverName: "Notes", titles: ["Mail", "Notes"]) == 1)
    }

    @Test("with no frame to go on, equality is preferred over a prefix")
    func exactBeatsPrefix() {
        // Nothing sits at the requested frame, so these are every window the
        // app has. Without trying equality first, "Untitled" is ambiguous.
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Untitled",
                titles: ["Untitled 2", "Untitled"],
                candidates: .everyWindow
            ) == 1
        )
    }

    @Test("two windows sharing a title decide nothing")
    func ambiguousExact() {
        #expect(AXWindowMatch.uniqueTitle(serverName: "Untitled", titles: ["Untitled", "Untitled"]) == nil)
    }

    @Test("two windows sharing a prefix decide nothing")
    func ambiguousPrefix() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Doc",
                titles: ["Doc - Pages", "Doc - Preview"]
            ) == nil
        )
    }

    @Test("no window carrying the name yields nothing")
    func noMatch() {
        #expect(AXWindowMatch.uniqueTitle(serverName: "Ghost", titles: Self.chrome) == nil)
    }

    @Test("an absent or empty server name never matches by prefix")
    func emptyName() {
        // Every title has the empty string as a prefix; matching on it would
        // pick an arbitrary window.
        #expect(AXWindowMatch.uniqueTitle(serverName: nil, titles: Self.chrome) == nil)
        #expect(AXWindowMatch.uniqueTitle(serverName: "", titles: Self.chrome) == nil)
    }

    @Test("a window with no title is skipped rather than matched")
    func nilTitles() {
        #expect(AXWindowMatch.uniqueTitle(serverName: "Notes", titles: [nil, "Notes - Edited"]) == 1)
        #expect(AXWindowMatch.uniqueTitle(serverName: "Notes", titles: [nil, nil]) == nil)
    }
}

/**
 The window server hands back a long title with its middle elided, so the
 name the caller holds is the real title with a hole in it.
 */
@Suite("AXWindowMatch, elided server names")
struct AXWindowMatchElidedTests {
    /// A GitHub tab long enough for the window server to shorten it.
    private static let longTitle =
        "feat(companion): Option+S shares a screen on a call, Option+D draws "
        + "(#42159) . example-org/example-repo@93e93af - Google Chrome - Alice"

    @Test("a name shortened in the middle still finds its window")
    func elidedMiddle() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "feat(companion): Option+S sha\u{2026}e-org/example-repo@93e93af",
                titles: ["Example Assistant - Google Chrome - Alice", Self.longTitle],
                candidates: .sharingOneFrame
            ) == 1
        )
    }

    @Test("the tail has to fit as well as the head")
    func tailMustFit() {
        // Same beginning, different commit: the head alone would match both.
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "feat(companion): Option+S sha\u{2026}@0000000",
                titles: [Self.longTitle],
                candidates: .sharingOneFrame
            ) == nil
        )
    }

    @Test("a tail is only matched after the head, never inside it")
    func tailAfterHeadOnly() {
        // Both ends of a shortened name can carry the same text.
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "2026 Report\u{2026}2026",
                titles: ["2026 Report draft - Chrome"],
                candidates: .sharingOneFrame
            ) == nil
        )
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "2026 Report\u{2026}2026",
                titles: ["2026 Report for the year 2026 - Chrome"],
                candidates: .sharingOneFrame
            ) == 0
        )
    }

    @Test("two windows fitting one shortened name decide nothing")
    func elidedAmbiguous() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Report\u{2026}2026",
                titles: ["Report for Q1 2026 - Chrome", "Report for Q2 2026 - Chrome"],
                candidates: .sharingOneFrame
            ) == nil
        )
    }

    @Test("a name that is only an ellipsis names no window")
    func onlyEllipsis() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "\u{2026}",
                titles: ["Anything - Chrome"],
                candidates: .sharingOneFrame
            ) == nil
        )
    }

    @Test("an unshortened name is left to the ordinary comparisons")
    func notElided() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Example Assistant",
                titles: ["Example Assistant - Google Chrome - Alice"],
                candidates: .sharingOneFrame
            ) == 0
        )
    }
}
