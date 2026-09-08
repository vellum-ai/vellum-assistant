import Testing

@testable import MacHelperCore

@Suite("AXWindowMatch")
struct AXWindowMatchTests {
    /// The five Chrome windows that produced JARVIS-1765, all at one frame.
    private static let chrome = [
        "Weekly Planning / User Stories | Notes - Google Chrome - Alice (example.com)",
        "Example Assistant - Google Chrome - Alice",
        "Inbox (1) - user@example.com - Mail - Google Chrome - Alice (example.com)",
        "Quarterly Report - Google Chrome - Alice (example.com)",
    ]

    @Test("an app that appends its own suffix still resolves")
    func chromeSuffix() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Weekly Planning / User Stories | Notes",
                titles: Self.chrome
            ) == 0
        )
        #expect(
            AXWindowMatch.uniqueTitle(serverName: "Example Assistant", titles: Self.chrome)
                == 1
        )
    }

    @Test("an exact title still wins")
    func exactMatch() {
        #expect(AXWindowMatch.uniqueTitle(serverName: "Notes", titles: ["Mail", "Notes"]) == 1)
    }

    @Test("equality is preferred over a longer prefix match")
    func exactBeatsPrefix() {
        // Without trying equality first, "Untitled" would be ambiguous here.
        #expect(
            AXWindowMatch.uniqueTitle(serverName: "Untitled", titles: ["Untitled 2", "Untitled"])
                == 1
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
