import Testing

@testable import MacHelperCore

@Suite("AXLabel.nonBlank")
struct AXLabelNonBlankTests {
    @Test("an empty string carries no name")
    func empty() {
        // The shape an icon-only control takes: `AXTitle` is present and blank,
        // so only a test on emptiness reaches the attribute that names it.
        #expect(AXLabel.nonBlank("") == nil)
    }

    @Test("a missing attribute carries no name")
    func absent() {
        #expect(AXLabel.nonBlank(nil) == nil)
    }

    @Test("whitespace alone carries no name")
    func blank() {
        #expect(AXLabel.nonBlank("   ") == nil)
        #expect(AXLabel.nonBlank("\n\t") == nil)
    }

    @Test("a name comes back exactly as the app spells it")
    func unmodified() {
        // ` Reset All` is a real iMovie title. Trimming it would change the
        // string a caller matches against.
        #expect(AXLabel.nonBlank(" Reset All") == " Reset All")
        #expect(AXLabel.nonBlank("color balance") == "color balance")
    }

    @Test("chaining falls past the blank attributes to the naming one")
    func chains() {
        // How the enumerator asks: title, then description, then the tooltip.
        let title: String? = ""
        let description: String? = nil
        let help: String? = "Color balance"
        #expect(
            (AXLabel.nonBlank(title) ?? AXLabel.nonBlank(description)
                ?? AXLabel.nonBlank(help)) == "Color balance"
        )
    }

    @Test("chaining stops at the first attribute that names the element")
    func chainStopsEarly() {
        // `??` leaves the rest unevaluated, which is what keeps an element
        // that answers on its title to a single read of the target app.
        var reads = 0
        func read(_ value: String?) -> String? {
            reads += 1
            return value
        }
        let name = AXLabel.nonBlank(read("Share")) ?? AXLabel.nonBlank(read("unused"))
        #expect(name == "Share")
        #expect(reads == 1)
    }
}

@Suite("AXLabel.collapsed")
struct AXLabelCollapsedTests {
    @Test("a newline cannot split one element into two")
    func collapsesNewlines() {
        // A library row's tooltip is its name, a newline, then its path.
        #expect(
            AXLabel.collapsed("Library\n/Users/user1/Movies/L.imovielibrary")
                == "Library /Users/user1/Movies/L.imovielibrary"
        )
    }

    @Test("runs of whitespace become one space")
    func collapsesRuns() {
        #expect(AXLabel.collapsed("Play  \t Pause") == "Play Pause")
    }

    @Test("surrounding whitespace is dropped")
    func trims() {
        #expect(AXLabel.collapsed(" Reset All ") == "Reset All")
    }

    @Test("text the user is reading is kept whole however long")
    func keepsLength() {
        let long = String(repeating: "sentence ", count: 40)
        #expect(AXLabel.collapsed(long).count == 359)
    }
}

@Suite("AXLabel.singleLine")
struct AXLabelSingleLineTests {
    @Test("a long name is capped with an ellipsis at the limit")
    func caps() {
        let capped = AXLabel.singleLine(String(repeating: "a", count: 200), max: 10)
        #expect(capped.count == 10)
        #expect(capped.hasSuffix("…"))
    }

    @Test("a name at the limit is left alone")
    func exactLength() {
        #expect(AXLabel.singleLine("abcde", max: 5) == "abcde")
    }

    @Test("a name is collapsed as well as capped")
    func collapsesToo() {
        #expect(AXLabel.singleLine("Play  Pause") == "Play Pause")
    }
}

@Suite("AXLabel.shortlist")
struct AXLabelShortlistTests {
    @Test("the list stops at the limit")
    func stopsAtLimit() {
        let labels = (1...100).map { "Control \($0)" }
        let shortlisted = AXLabel.shortlist(labels, limit: 8, each: 60)
        #expect(shortlisted.count == 8)
        #expect(shortlisted.first == "Control 1")
        #expect(shortlisted.last == "Control 8")
    }

    @Test("a shorter list is kept whole")
    func keepsShortList() {
        #expect(AXLabel.shortlist(["Send", "Cancel"], limit: 8, each: 60) == ["Send", "Cancel"])
    }

    @Test("every label is capped, not just the list")
    func capsEachLabel() {
        // The shape a page gives it: one element carrying a paragraph of
        // `aria-label`, which is what makes the payload rather than the count.
        let paragraph = String(repeating: "word ", count: 200)
        let shortlisted = AXLabel.shortlist([paragraph, "Send"], limit: 8, each: 20)
        #expect(shortlisted[0].count == 20)
        #expect(shortlisted[0].hasSuffix("…"))
        #expect(shortlisted[1] == "Send")
    }

    @Test("a label spanning lines becomes one")
    func collapsesLabels() {
        #expect(AXLabel.shortlist(["Play\nPause"], limit: 8, each: 60) == ["Play Pause"])
    }

    @Test("an empty list stays empty")
    func empty() {
        #expect(AXLabel.shortlist([], limit: 8, each: 60).isEmpty)
    }
}
