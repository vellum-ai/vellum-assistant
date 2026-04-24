import Foundation

/// Generates human-readable instance names for assistants, mirroring the
/// CLI's `random-name.ts` logic: `{species}-{name}-{nanoid(6)}`.
///
/// The name list is identical to the CLI so that names produced by the
/// desktop app are indistinguishable from CLI-generated names.
enum RandomNameGenerator {

    // MARK: - Name List (identical to cli/src/lib/random-name.ts)

    private static let funNameSlugs = [
        "socrates", "plato", "aristotle", "confucius", "laozi",
        "seneca", "aurelius", "hypatia", "descartes", "spinoza",
        "kant", "voltaire", "nietzsche", "kierkegaard", "bach",
        "mozart", "beethoven", "vivaldi", "handel", "haydn",
        "chopin", "liszt", "schubert", "brahms", "tchaikovsky",
        "debussy", "mahler", "euclid", "archimedes", "galileo",
        "newton", "kepler", "lovelace", "curie", "darwin",
        "noether", "fibonacci", "gutenberg", "faraday", "mendel",
    ]

    /// Characters used for the random suffix (matches nanoid's lowercase+digit alphabet).
    private static let nanoidAlphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    private static let nanoidLength = 6

    // MARK: - Public API

    /// Generate a random suffix in the form `name-xxxxxx`.
    ///
    /// Equivalent to CLI's `generateRandomSuffix()`.
    static func generateRandomSuffix() -> String {
        let name = funNameSlugs.randomElement()!
        let id = String((0..<nanoidLength).map { _ in nanoidAlphabet.randomElement()! })
        return "\(name)-\(id)"
    }

    /// Generate an instance name for a new assistant.
    ///
    /// If `explicitName` is provided and non-empty, it is returned as-is.
    /// Otherwise produces `{species}-{name}-{nanoid(6)}`.
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
