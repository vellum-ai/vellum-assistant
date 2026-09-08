import Foundation

/// Choosing the name an accessibility element goes by.
///
/// **This exists because "has the attribute" and "has a name" are different
/// questions.** A great many icon-only controls carry `AXTitle` as an empty
/// string rather than not carrying it at all, so a plain `??` chain over
/// optionals stops at the first attribute that is merely *present* and never
/// reaches the one that actually names the control. iMovie's whole colour
/// toolbar reads that way: empty `AXTitle`, `AXDescription` of "color
/// balance". So the fallback is on emptiness, not on nil.
public enum AXLabel {
    /// The first candidate that is neither nil nor blank, or nil when none is.
    ///
    /// Whitespace-only is treated as absent for the same reason empty is: a
    /// name the user cannot read is not a name the model can point at.
    public static func firstMeaningful(_ candidates: String?...) -> String? {
        firstMeaningful(in: candidates)
    }

    /// The array form, for callers holding a built-up list.
    public static func firstMeaningful(in candidates: [String?]) -> String? {
        for candidate in candidates {
            guard let candidate else { continue }
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                return candidate
            }
        }
        return nil
    }

    /// `label` as one line of at most `max` characters.
    ///
    /// The tree is read a line per element, so a label carrying a newline
    /// would silently become two elements to anything reading it back. A
    /// tooltip is the usual source: `AXHelp` runs to whole sentences, and a
    /// library row's is its title followed by its path.
    public static func singleLine(_ label: String, max: Int = 60) -> String {
        let collapsed = label
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        guard collapsed.count > max else { return collapsed }
        return collapsed.prefix(max - 1) + "…"
    }
}
