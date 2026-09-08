import Foundation

/// Finding the one control a person named.
///
/// **This exists so that pointing at something does not go through a guess at
/// its coordinates.** The accessibility tree already knows where every
/// labelled control is, to the point; what it does not know is which of them
/// someone meant by "the white balance button". That is this.
///
/// The rule throughout is **exactly one or nothing**. A ring drawn confidently
/// around the wrong control is worse than one not drawn at all, because the
/// person following it has no way to tell. Every widening step below still
/// refuses when it fits more than one candidate, and the caller is handed the
/// names that fit so it can say what it found instead of guessing between them.
public enum AXTargetMatch {
    /// One candidate control: whatever it is called, and what kind of thing it
    /// is. `role` is only ever a tie-breaker, never a filter, since the words
    /// people use for a control ("button", "toggle") rarely match its role.
    public struct Candidate: Sendable, Equatable {
        public let label: String
        public let role: String

        public init(label: String, role: String) {
            self.label = label
            self.role = role
        }
    }

    /// What came of looking for `query`.
    public enum Outcome: Sendable, Equatable {
        /// The index of the single candidate that fits.
        case found(Int)
        /// More than one fits. Carries their labels, so the caller can ask
        /// which was meant rather than picking.
        case ambiguous([String])
        /// None fits. Carries the labels there were, so the caller can say
        /// what is actually on the surface.
        case notFound([String])
    }

    /// The candidate `query` names, by increasingly forgiving comparisons.
    ///
    /// In order: the same string; the same string ignoring case, punctuation
    /// and spacing; one containing the other. The first comparison to fit
    /// exactly one candidate wins, so a widening step is never reached by a
    /// query an earlier one had already settled.
    public static func locate(query: String, among candidates: [Candidate]) -> Outcome {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else {
            return .notFound(candidates.map(\.label))
        }

        let comparisons: [(Candidate) -> Bool] = [
            { $0.label == needle },
            { normalise($0.label) == normalise(needle) },
            { contains(normalise($0.label), normalise(needle)) },
        ]

        for fits in comparisons {
            let hits = candidates.indices.filter { fits(candidates[$0]) }
            if hits.count == 1 {
                return .found(hits[0])
            }
            if hits.count > 1 {
                // The role is the last thing that can separate them, and only
                // when the query actually named one: "close button" against a
                // button and a menu item both labelled "Close".
                let byRole = hits.filter { mentionsRole(needle, candidates[$0].role) }
                if byRole.count == 1 {
                    return .found(byRole[0])
                }
                return .ambiguous(hits.map { candidates[$0].label })
            }
        }
        return .notFound(candidates.map(\.label))
    }

    /// Casing, punctuation and spacing removed, so "Color Balance", "color
    /// balance" and "colour-balance" are one string. Diacritics are folded for
    /// the same reason.
    private static func normalise(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map(String.init)
            .joined()
    }

    /// Either string containing the other, so both "balance" and "the color
    /// balance toggle" find `color balance`. Guarded against a needle so short
    /// it would fit half the surface.
    private static func contains(_ label: String, _ needle: String) -> Bool {
        guard needle.count >= 3 else { return label == needle }
        return label.contains(needle) || needle.contains(label)
    }

    /// Whether the query names this role in the words a person would use.
    private static func mentionsRole(_ query: String, _ role: String) -> Bool {
        let bare = normalise(role.hasPrefix("AX") ? String(role.dropFirst(2)) : role)
        guard !bare.isEmpty else { return false }
        return normalise(query).contains(bare)
    }
}
