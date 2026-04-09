import Foundation

/// Generates human-readable instance names for assistants, mirroring the
/// CLI's `random-name.ts` logic: `{species}-{adjective}-{noun}-{nanoid(6)}`.
///
/// The word lists are identical to the CLI so that names produced by the
/// desktop app are indistinguishable from CLI-generated names.
enum RandomNameGenerator {

    // MARK: - Word Lists (identical to cli/src/lib/random-name.ts)

    private static let adjectives = [
        "brave", "calm", "eager", "fair", "glad",
        "keen", "bold", "cool", "fast", "warm",
        "wise", "kind", "pure", "safe", "true",
        "wild", "free", "deep", "firm", "soft",
        "rich", "rare", "slim", "vast", "neat",
        "pale", "dark", "lean", "raw", "dry",
        "bright", "crisp", "deft", "faint", "grand",
        "hale", "just", "lush", "mild", "prime",
        "quick", "sharp", "stark", "swift", "tame",
        "tight", "vivid", "plush", "dense", "lucid",
        "fresh", "fleet", "stout", "brisk", "clear",
        "quiet", "noble", "sleek", "agile", "spry",
    ]

    private static let nouns = [
        "fox", "owl", "elk", "ant", "bee",
        "ram", "eel", "cod", "jay", "yak",
        "bat", "cub", "doe", "hen", "kit",
        "pup", "ray", "tern", "wren", "lark",
        "hawk", "dove", "lynx", "hare", "frog",
        "newt", "crab", "moth", "seal", "toad",
        "wolf", "bear", "deer", "swan", "crane",
        "finch", "robin", "otter", "mink", "vole",
        "shrew", "pike", "bass", "trout", "perch",
        "stork", "egret", "heron", "snipe", "quail",
        "raven", "swift", "grouse", "ibis", "mole",
        "asp", "koi", "gnu", "dace", "skua",
    ]

    /// Characters used for the random suffix (matches nanoid's lowercase+digit alphabet).
    private static let nanoidAlphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    private static let nanoidLength = 6

    // MARK: - Public API

    /// Generate a random suffix in the form `adjective-noun-xxxxxx`.
    ///
    /// Equivalent to CLI's `generateRandomSuffix()`.
    static func generateRandomSuffix() -> String {
        let adj = adjectives.randomElement()!
        let noun = nouns.randomElement()!
        let id = String((0..<nanoidLength).map { _ in nanoidAlphabet.randomElement()! })
        return "\(adj)-\(noun)-\(id)"
    }

    /// Generate an instance name for a new assistant.
    ///
    /// If `explicitName` is provided and non-empty, it is returned as-is.
    /// Otherwise produces `{species}-{adjective}-{noun}-{nanoid(6)}`.
    ///
    /// Equivalent to CLI's `generateInstanceName(species, explicitName)`.
    static func generateInstanceName(
        species: String = "vellum",
        explicitName: String? = nil
    ) -> String {
        if let name = explicitName, !name.isEmpty {
            return name
        }
        return "\(species)-\(generateRandomSuffix())"
    }
}
