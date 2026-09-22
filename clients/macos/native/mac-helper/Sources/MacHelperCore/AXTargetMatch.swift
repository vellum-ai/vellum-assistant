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
    /// One candidate control: what it is called.
    public struct Candidate: Sendable, Equatable {
        public let label: String

        public init(label: String) {
            self.label = label
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
    /// In order: the same string, then the same string ignoring case,
    /// punctuation and spacing. Both are mechanical: they decide that two
    /// spellings are one name, which is not a judgement about what someone
    /// meant.
    ///
    /// Nothing looser, deliberately. Reading a label inside a longer phrase is
    /// where a guess starts, and it reaches confidently wrong controls: a
    /// query long enough to describe one contains short words that name
    /// others, so "the Send button" finds a control called `End` alone and
    /// without ambiguity. Deciding which control a phrase meant is the
    /// assistant's call, so a query that fits nothing comes back carrying the
    /// labels instead, for it to choose from and ask again.
    public static func locate(query: String, among candidates: [Candidate]) -> Outcome {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else {
            return .notFound(candidates.map(\.label))
        }

        let comparisons: [(Candidate) -> Bool] = [
            { $0.label == needle },
            { normalise($0.label) == normalise(needle) },
        ]

        for fits in comparisons {
            let hits = candidates.indices.filter { fits(candidates[$0]) }
            if hits.count == 1 {
                return .found(hits[0])
            }
            if hits.count > 1 {
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

}
