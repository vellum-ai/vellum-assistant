import Foundation

/// Thin wrapper over `UserDefaults.standard` that namespaces every key under
/// a per-assistant prefix (`"<assistantId>.<key>"`). Stateless — owns no
/// identity of its own; the caller supplies the assistant id at construction.
///
/// The lockfile (`LockfileAssistant`) remains the source of truth for
/// assistant identity; `UserDefaults` remains the backing store for settings,
/// namespaced here so two assistants on the same host can carry independent
/// values for the same logical key.
@MainActor
struct ScopedDefaults {
    let assistantId: String
    private let defaults: UserDefaults

    init(assistantId: String, defaults: UserDefaults = .standard) {
        self.assistantId = assistantId
        self.defaults = defaults
    }

    private func scopedKey(_ key: String) -> String {
        "\(assistantId).\(key)"
    }

    func string(forKey key: String) -> String? {
        defaults.string(forKey: scopedKey(key))
    }

    func bool(forKey key: String) -> Bool {
        defaults.bool(forKey: scopedKey(key))
    }

    func integer(forKey key: String) -> Int {
        defaults.integer(forKey: scopedKey(key))
    }

    func object(forKey key: String) -> Any? {
        defaults.object(forKey: scopedKey(key))
    }

    func set(_ value: Any?, forKey key: String) {
        defaults.set(value, forKey: scopedKey(key))
    }
}

