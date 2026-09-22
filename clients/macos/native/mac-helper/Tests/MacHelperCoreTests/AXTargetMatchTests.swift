import Testing

@testable import MacHelperCore

@Suite("AXTargetMatch")
struct AXTargetMatchTests {
    private typealias Candidate = AXTargetMatch.Candidate

    /// iMovie's toolbar as the enumerator reports it once labels are read
    /// properly, which is what this matcher is for.
    private static let iMovie = [
        Candidate(label: "enhance"),
        Candidate(label: "color balance"),
        Candidate(label: "color correction"),
        Candidate(label: "cropping"),
        Candidate(label: "stabilization"),
        Candidate(label: "volume"),
        Candidate(label: "speed"),
        Candidate(label: "My Media"),
        Candidate(label: "Titles"),
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

    /// A phrase is not resolved here. It comes back with the labels so the
    /// assistant picks one, rather than a string match guessing for it.
    @Test("a query wrapped in extra words is handed back, not guessed at")
    func phraseIsNotGuessed() {
        guard case let .notFound(labels) =
            AXTargetMatch.locate(query: "the stabilization button", among: Self.iMovie)
        else {
            Issue.record("a phrase must not be resolved by string matching")
            return
        }
        #expect(labels.contains("stabilization"))
    }

    @Test("an exact label wins over a longer one containing it")
    func exactBeatsLonger() {
        let candidates = [
            Candidate(label: "volume"),
            Candidate(label: "volume mixer"),
        ]
        #expect(AXTargetMatch.locate(query: "volume", among: candidates) == .found(0))
    }

    @Test("two controls fitting equally are reported, not chosen between")
    func ambiguous() {
        let candidates = [
            Candidate(label: "Close"),
            Candidate(label: "Close"),
        ]
        #expect(
            AXTargetMatch.locate(query: "Close", among: candidates)
                == .ambiguous(["Close", "Close"])
        )
    }

    /// Which of two controls sharing a name was meant is a judgement, so it
    /// goes back to the assistant rather than being settled by their roles.
    @Test("a phrase naming a kind of control is still handed back")
    func roleIsNotATieBreak() {
        let candidates = [Candidate(label: "Close"), Candidate(label: "Close")]
        guard case .notFound = AXTargetMatch.locate(query: "Close button", among: candidates)
        else {
            Issue.record("a role must not decide which control was meant")
            return
        }
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

    /// A phrase describing one control contains words that name others.
    @Test("a short label inside a longer query is not a match")
    func shortLabelInsideQuery() {
        let candidates = [Candidate(label: "End")]
        guard case .notFound = AXTargetMatch.locate(query: "the Send button", among: candidates)
        else {
            Issue.record("\"End\" must not answer to \"the Send button\"")
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
