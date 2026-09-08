import Testing

@testable import MacHelperCore

@Suite("AXLabel")
struct AXLabelTests {
    @Test("an empty first candidate is fallen past, not returned")
    func emptyFallsThrough() {
        // The whole bug: `AXTitle` present as "" used to satisfy `??` and hide
        // the description behind it.
        #expect(AXLabel.firstMeaningful("", "color balance") == "color balance")
    }

    @Test("nil is fallen past as before")
    func nilFallsThrough() {
        #expect(AXLabel.firstMeaningful(nil, "color balance") == "color balance")
    }

    @Test("whitespace-only is treated as absent")
    func blankFallsThrough() {
        #expect(AXLabel.firstMeaningful("   ", "\n\t", "Color balance") == "Color balance")
    }

    @Test("the first meaningful candidate wins")
    func firstWins() {
        #expect(AXLabel.firstMeaningful("Share", "share button", "Share this movie") == "Share")
    }

    @Test("the winner is returned unmodified, not trimmed")
    func returnsOriginal() {
        // ` Reset All` is a real iMovie title; trimming it would change the
        // name the model is asked to match against.
        #expect(AXLabel.firstMeaningful(" Reset All") == " Reset All")
    }

    @Test("all blank or absent yields nil")
    func nothingMeaningful() {
        #expect(AXLabel.firstMeaningful(nil, "", "  ") == nil)
        #expect(AXLabel.firstMeaningful() == nil)
    }

    @Test("the array form agrees with the variadic one")
    func arrayForm() {
        #expect(AXLabel.firstMeaningful(in: [nil, "", "speed"]) == "speed")
    }
}

@Suite("AXLabel.singleLine")
struct AXLabelSingleLineTests {
    @Test("a newline in a label cannot become a second element")
    func collapsesNewlines() {
        // A library row's tooltip is its name, a newline, then its path.
        #expect(
            AXLabel.singleLine("iMovie Library\n/Users/alex/Movies/L.imovielibrary", max: 100)
                == "iMovie Library /Users/alex/Movies/L.imovielibrary"
        )
    }

    @Test("runs of whitespace collapse to one space")
    func collapsesRuns() {
        #expect(AXLabel.singleLine("Play  \t Pause") == "Play Pause")
    }

    @Test("surrounding whitespace is dropped")
    func trims() {
        #expect(AXLabel.singleLine(" Reset All ") == "Reset All")
    }

    @Test("a long label is capped with an ellipsis at the limit")
    func caps() {
        let capped = AXLabel.singleLine(String(repeating: "a", count: 200), max: 10)
        #expect(capped.count == 10)
        #expect(capped.hasSuffix("…"))
    }

    @Test("a label at the limit is left alone")
    func exactLength() {
        #expect(AXLabel.singleLine("abcde", max: 5) == "abcde")
    }
}
