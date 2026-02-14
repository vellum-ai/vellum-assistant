import Foundation
import Security

extension Notification.Name {
    static let apiKeyManagerDidChange = Notification.Name("APIKeyManager.didChange")
}

/// Manages API keys in the macOS login keychain.
///
/// Uses the `security` CLI tool for writes so entries are created without
/// per-application ACLs — this lets the daemon (which also uses the `security`
/// CLI) read the same keychain item.
enum APIKeyManager {
    /// Shared with the daemon (keychain.ts uses service "vellum-assistant", account = provider name).
    private static let service = "vellum-assistant"

    // Legacy keychain entry (pre-daemon era). Migrated on first access.
    private static let legacyService = "com.vellum-assistant.anthropic-api-key"
    private static let legacyAccount = "anthropic-api-key"

    // MARK: - Anthropic (convenience wrappers for backward compatibility)

    static func getKey() -> String? { getKey(for: "anthropic") }
    static func setKey(_ key: String) { setKey(key, for: "anthropic") }
    static func deleteKey() { deleteKey(for: "anthropic") }

    /// Returns true if any known provider has a key configured.
    static func hasAnyKey() -> Bool {
        for provider in ["anthropic", "openai", "gemini", "fireworks"] {
            if getKey(for: provider) != nil { return true }
        }
        return false
    }

    // MARK: - Generic provider access

    static func getKey(for provider: String) -> String? {
        if provider == "anthropic" { migrateIfNeeded() }
        return cliGetKey(service: service, account: provider)
    }

    static func setKey(_ key: String, for provider: String) {
        cliSetKey(service: service, account: provider, value: key)
        notifyKeyDidChange()
    }

    static func deleteKey(for provider: String) {
        cliDeleteKey(service: service, account: provider)
        notifyKeyDidChange()
    }

    // MARK: - CLI Helpers

    /// Read a generic password via `security find-generic-password`.
    private static func cliGetKey(service: String, account: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", service, "-a", account, "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .newlines)
        } catch {
            return nil
        }
    }

    /// Write a generic password via `security add-generic-password -U` (update if exists).
    private static func cliSetKey(service: String, account: String, value: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    /// Delete a generic password via `security delete-generic-password`.
    private static func cliDeleteKey(service: String, account: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["delete-generic-password", "-s", service, "-a", account]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
        process.waitUntilExit()
    }

    // MARK: - Migration

    /// One-time migration from the legacy keychain entry to the daemon-shared entry.
    private static func migrateIfNeeded() {
        // Skip if new entry already exists
        if cliGetKey(service: service, account: "anthropic") != nil { return }

        // Read from legacy entry (uses Security.framework since the old entry was created with SecItemAdd)
        let legacyQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyService,
            kSecAttrAccount as String: legacyAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(legacyQuery as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else { return }

        // Write to new entry via CLI (no ACL restrictions)
        cliSetKey(service: service, account: "anthropic", value: key)

        // Delete legacy entry
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyService,
            kSecAttrAccount as String: legacyAccount
        ]
        SecItemDelete(deleteQuery as CFDictionary)
    }

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
