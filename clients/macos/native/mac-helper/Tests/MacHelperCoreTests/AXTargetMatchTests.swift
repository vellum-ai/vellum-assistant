import Testing

@testable import MacHelperCore

@Suite("AXTargetMatch")
struct AXTargetMatchTests {
    private typealias Candidate = AXTargetMatch.Candidate

    /// iMovie's toolbar as the enumerator reports it once labels are read
    /// properly, which is what this matcher is for.
    private static let iMovie = [
        Candidate(label: "enhance", role: "AXCheckBox"),
        Candidate(label: "color balance", role: "AXCheckBox"),
        Candidate(label: "color correction", role: "AXCheckBox"),
        Candidate(label: "cropping", role: "AXCheckBox"),
        Candidate(label: "stabilization", role: "AXCheckBox"),
        Candidate(label: "volume", role: "AXCheckBox"),
        Candidate(label: "speed", role: "AXCheckBox"),
        Candidate(label: "My Media", role: "AXButton"),
        Candidate(label: "Titles", role: "AXButton"),
    ]

    @Test("the exact label is found")
    func exact() {
        #expect(AXTargetMatch.locate(query: "color balance", among: Self.iMovie) == .found(1))
    }

    @Test("casing and spacing do not matter")
    func normalised() {
        #expect(AXTargetMatch.locate(query: "Color Balance", among: Self.iMovie) == .found(1))
        #expect(AXTargetMatch.locate(query: "colorbalance", among: Self.iMovie) == .found(1))
        #expect(AXTargetMatch.locate(query: "my media", among: Self.iMovie) == .found(7))
    }

    @Test("a query wrapped in extra words still finds its control")
    func containment() {
        // What a model actually writes when it is talking as it points.
        #expect(AXTargetMatch.locate(query: "the stabilization button", among: Self.iMovie) == .found(4))
    }

    @Test("an exact label wins over a longer one containing it")
    func exactBeatsContainment() {
        // "color balance" is a prefix of nothing here, but it is contained in
        // no other label either; the risk is the reverse direction, so pin it.
        let candidates = [
            Candidate(label: "volume", role: "AXCheckBox"),
            Candidate(label: "volume mixer", role: "AXButton"),
        ]
        #expect(AXTargetMatch.locate(query: "volume", among: candidates) == .found(0))
    }

    @Test("two controls fitting equally are reported, not chosen between")
    func ambiguous() {
        let candidates = [
            Candidate(label: "Close", role: "AXButton"),
            Candidate(label: "Close", role: "AXMenuItem"),
        ]
        #expect(
            AXTargetMatch.locate(query: "Close", among: candidates)
                == .ambiguous(["Close", "Close"])
        )
    }

    @Test("naming the role separates two controls that share a label")
    func roleBreaksTheTie() {
        let candidates = [
            Candidate(label: "Close", role: "AXMenuItem"),
            Candidate(label: "Close", role: "AXButton"),
        ]
        #expect(AXTargetMatch.locate(query: "Close button", among: candidates) == .found(1))
    }

    @Test("a miss carries what was actually there")
    func notFound() {
        guard case let .notFound(labels) = AXTargetMatch.locate(query: "reticulate splines", among: Self.iMovie)
        else {
            Issue.record("expected notFound")
            return
        }
        #expect(labels.contains("color balance"))
        #expect(labels.count == Self.iMovie.count)
    }

    @Test("an empty query finds nothing rather than everything")
    func emptyQuery() {
        guard case .notFound = AXTargetMatch.locate(query: "   ", among: Self.iMovie) else {
            Issue.record("an empty query must not match")
            return
        }
    }

    @Test("a very short query is not allowed to match by containment")
    func shortQuery() {
        // "co" inside "color balance", "color correction" and "cropping" would
        // otherwise be ambiguous at best and arbitrary at worst.
        guard case .notFound = AXTargetMatch.locate(query: "co", among: Self.iMovie) else {
            Issue.record("a two-character query must not match by containment")
            return
        }
    }

    @Test("nothing on the surface is a miss, not a crash")
    func noCandidates() {
        #expect(AXTargetMatch.locate(query: "anything", among: []) == .notFound([]))
    }
}
