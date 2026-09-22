/// The keys a chord binding recognises, as the characters on their keycaps.
///
/// The set the caller names, rather than a table here: the helper has no idea
/// what a key means, so the app that binds the gestures is the side that gets
/// to say which letters it wants. A binding that names none recognises
/// nothing, which is what every press on this machine was before one existed.
///
/// Keys are matched by the character they carry unmodified, so the letter the
/// user sees on the keycap is the letter that answers on every layout. See
/// `KeyboardLayout.unmodifiedCharacter(for:)`, which is what a press has to be
/// resolved through before it reaches here.
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
    /// `characters` is what the key carries on the layout in use, which for a
    /// key with no character of its own can be empty or longer than one
    /// character. Neither is a key on offer here.
    public func match(_ characters: String) -> String? {
        let normalized = characters.lowercased()
        guard normalized.count == 1, keys.contains(normalized) else {
            return nil
        }
        return normalized
    }
}
