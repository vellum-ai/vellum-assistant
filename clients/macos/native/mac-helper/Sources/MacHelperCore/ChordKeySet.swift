/// The keys whose identity a chord on the held set is allowed to report.
///
/// The tap sees every key on the machine, and the hold detector needs only the
/// fact that one went down. This is the exception, and it is deliberately a
/// set the caller names rather than a table here: the helper has no idea what
/// a key means, so the app that binds the gestures is the side that gets to
/// say which two or three letters it wants named. A binding that names none
/// behaves exactly as one that could not name any, which is what every hold
/// before these gestures was.
///
/// Keys are matched by the character they produce, not by their position on
/// the board, so the letter the user sees on the keycap is the letter that
/// answers on every layout.
public struct ChordKeySet: Equatable, Sendable {
    private let keys: Set<String>

    public init(_ raw: [String] = []) {
        keys = Set(
            raw.compactMap { key in
                let normalized = key.lowercased()
                return normalized.count == 1 ? normalized : nil
            }
        )
    }

    public var isEmpty: Bool { keys.isEmpty }

    /// The named key `characters` is, or nil when it is not one of them.
    ///
    /// `characters` is what the key event says it produces, which for a dead
    /// key or a key with a modifier the layout composes with can be empty or
    /// longer than one character. Neither is a key on offer here.
    public func match(_ characters: String) -> String? {
        let normalized = characters.lowercased()
        guard normalized.count == 1, keys.contains(normalized) else {
            return nil
        }
        return normalized
    }
}
