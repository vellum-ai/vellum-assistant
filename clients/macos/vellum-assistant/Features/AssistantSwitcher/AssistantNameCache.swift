import Foundation

/// Persistent map of `assistantId → display name`, used by the menu-bar
/// switcher to render rows for non-active assistants. The active assistant's
/// name is fetched live from the gateway on every workspace switch and
/// written here as a side effect, so the cache slowly fills in as the user
/// visits each managed assistant at least once.
///
/// Backed by `UserDefaults` rather than the lockfile because the lockfile is
/// owned by the CLI and has no `name` field — coordinating a schema addition
/// across both writers would be churn for a UI-only affordance.
enum AssistantNameCache {
    private static let defaultsKey = "AssistantNameCache.namesById"

    static func name(for assistantId: String) -> String? {
        let map = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        return map[assistantId]
    }

    /// Records `name` for `assistantId`. No-ops on empty / whitespace input
    /// so we never overwrite a real name with garbage from a partial fetch.
    static func record(name: String, for assistantId: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var map = UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
        if map[assistantId] == trimmed { return }
        map[assistantId] = trimmed
        UserDefaults.standard.set(map, forKey: defaultsKey)
    }
}
