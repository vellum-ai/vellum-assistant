import Testing

@testable import MacHelperCore

@Suite("AXWindowMatch")
struct AXWindowMatchTests {
    /// The five Chrome windows that produced JARVIS-1765, all at one frame.
    private static let chrome = [
        "Ambient Agent / Riding Shotgun — User Stories | Notion - Google Chrome - Alex (vellum.ai)",
        "Vellum Assistant - Google Chrome - Alex",
        "Inbox (1) - alex@vellum.ai - vellum.ai Mail - Google Chrome - Alex (vellum.ai)",
        "Seven Repackaging Plays - Google Chrome - Alex (vellum.ai)",
    ]

    @Test("an app that appends its own suffix still resolves")
    func chromeSuffix() {
        #expect(
            AXWindowMatch.uniqueTitle(
                serverName: "Ambient Agent / Riding Shotgun — User Stories | Notion",
                titles: Self.chrome
            ) == 0
        )
        #expect(
            AXWindowMatch.uniqueTitle(serverName: "Vellum Assistant", titles: Self.chrome) == 1
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
