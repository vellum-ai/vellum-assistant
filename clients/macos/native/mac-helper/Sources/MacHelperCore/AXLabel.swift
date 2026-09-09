import Foundation

/// Choosing the name an accessibility element goes by, and rendering it.
///
/// **This exists because "has the attribute" and "has a name" are different
/// questions.** A great many icon-only controls carry `AXTitle` as an empty
/// string rather than not carrying it at all, so a chain over optionals alone
/// stops at the first attribute that is merely *present* and never reaches the
/// one that actually names the control. iMovie's colour toolbar reads that
/// way: an empty `AXTitle`, and `AXDescription` of "color balance".
///
/// {@link nonBlank} is the piece that makes a `??` chain work on emptiness
/// rather than on nil, and it is deliberately shaped for that: reading an
/// accessibility attribute is synchronous IPC into another process, so the
/// attributes behind the first one that answers must not be read at all.
public enum AXLabel {
    /// `text`, or nil when it carries nothing a person could read.
    ///
    /// Whitespace-only counts as nothing for the same reason empty does: a
    /// name nobody can see is not a name anything can be pointed at by. The
    /// text comes back as it was, since a label is matched and displayed by
    /// what the app actually calls it.
    public static func nonBlank(_ text: String?) -> String? {
        guard let text,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return text
    }

    /// `text` with every run of whitespace as a single space.
    ///
    /// The tree is read a line per element, so a label carrying a newline
    /// becomes two elements to anything reading it back. Tooltips are the
    /// usual source: `AXHelp` runs to whole sentences, and a library row's is
    /// its title followed by its path.
    public static func collapsed(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// `text` as one line of at most `max` characters.
    ///
    /// For a name, where past a certain length what is being carried is a
    /// description of the control rather than the word for it. Text the user
    /// is reading on screen is kept whole by {@link collapsed} instead: its
    /// tail can be the half of an error message that says what to do.
    public static func singleLine(_ text: String, max: Int = 60) -> String {
        let line = collapsed(text)
        guard line.count > max else { return line }
        return line.prefix(max - 1) + "…"
    }

    /// The first `limit` of `labels`, each one line of at most `each`
    /// characters.
    ///
    /// For a list of names sent somewhere to be chosen between. The tree they
    /// were read from can be a web page: ten thousand elements, any number of
    /// them carrying a paragraph of `aria-label` apiece. Sent whole, that is a
    /// payload nothing reading it can act on, so the list is bounded where it
    /// is produced rather than where it is read.
    ///
    /// The order it was given is kept, since a tree is read in the order its
    /// elements are laid out. How many there were is the caller's to carry
    /// separately: this decides only how many travel.
    public static func shortlist(_ labels: [String], limit: Int, each: Int) -> [String] {
        labels.prefix(limit).map { singleLine($0, max: each) }
    }
}
