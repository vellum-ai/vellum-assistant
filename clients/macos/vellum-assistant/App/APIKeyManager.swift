import Foundation
import Security

extension Notification.Name {
    static let apiKeyManagerDidChange = Notification.Name("APIKeyManager.didChange")
    static let openDynamicWorkspace = Notification.Name("MainWindow.openDynamicWorkspace")
    static let updateDynamicWorkspace = Notification.Name("MainWindow.updateDynamicWorkspace")
    static let dismissDynamicWorkspace = Notification.Name("MainWindow.dismissDynamicWorkspace")
    static let openDocumentEditor = Notification.Name("MainWindow.openDocumentEditor")
    static let navigateToSettingsTab = Notification.Name("MainWindow.navigateToSettingsTab")
    static let activationKeyChanged = Notification.Name("activationKeyChanged")
    static let identityChanged = Notification.Name("identityChanged")
    static let pinAppToHomebase = Notification.Name("MainWindow.pinAppToHomebase")
    static let appPreviewImageCaptured = Notification.Name("MainWindow.appPreviewImageCaptured")
    static let requestAppPreview = Notification.Name("MainWindow.requestAppPreview")
}

/// Manages API keys in the macOS login keychain via native SecItem* APIs.
enum APIKeyManager {
    /// Shared with the daemon (keychain.ts uses service "vellum-assistant", account = provider name).
    private static let service = "vellum-assistant"

    // Legacy keychain entry (pre-daemon era). Migrated on first access.
    private static let legacyService = "com.vellum-assistant.anthropic-api-key"
    private static let legacyAccount = "anthropic-api-key"

    private struct CachedKeyRead {
        let value: String?
        let cachedAt: Date
    }

    private static var readCache: [String: CachedKeyRead] = [:]
    private static let readCacheLock = NSLock()
    private static let readCacheHitTTL: TimeInterval = 60
    /// Short TTL for misses so external writes (e.g. from the daemon) are picked up quickly
    /// while still batching rapid sequential calls like hasAnyKey().
    private static let readCacheMissTTL: TimeInterval = 5

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
        migrateCliToNativeIfNeeded()

        let cached = cachedValue(for: provider)
        if cached.hit { return cached.value }

        if provider == "anthropic" {
            // migrateIfNeeded returns the key if it was already read during
            // the migration check, avoiding a redundant security CLI spawn
            // (each spawn triggers a macOS keychain authorization prompt).
            if let migrated = migrateIfNeeded() {
                setCachedValue(migrated, for: provider)
                return migrated
            }
        }
        let value = nativeGetKey(service: service, account: provider)
        setCachedValue(value, for: provider)
        return value
    }

    static func setKey(_ key: String, for provider: String) {
        if nativeSetKey(service: service, account: provider, value: key) {
            setCachedValue(key, for: provider)
        } else {
            invalidateCachedValue(for: provider)
        }
        notifyKeyDidChange()
    }

    static func deleteKey(for provider: String) {
        nativeDeleteKey(service: service, account: provider)
        invalidateCachedValue(for: provider)
        notifyKeyDidChange()
    }

    private static func cachedValue(for provider: String) -> (hit: Bool, value: String?) {
        readCacheLock.lock()
        defer { readCacheLock.unlock() }

        guard let entry = readCache[provider] else {
            return (false, nil)
        }

        let ttl = entry.value != nil ? readCacheHitTTL : readCacheMissTTL
        if Date().timeIntervalSince(entry.cachedAt) > ttl {
            readCache.removeValue(forKey: provider)
            return (false, nil)
        }

        return (true, entry.value)
    }

    private static func setCachedValue(_ value: String?, for provider: String) {
        readCacheLock.lock()
        defer { readCacheLock.unlock() }
        readCache[provider] = CachedKeyRead(value: value, cachedAt: Date())
    }

    private static func invalidateCachedValue(for provider: String) {
        readCacheLock.lock()
        defer { readCacheLock.unlock() }
        readCache.removeValue(forKey: provider)
    }

    // MARK: - Native Keychain (SecItem)

    /// Read a generic password via `SecItemCopyMatching`.
    private static func nativeGetKey(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    /// Write a generic password via `SecItemAdd` (deletes existing first).
    @discardableResult
    private static func nativeSetKey(service: String, account: String, value: String) -> Bool {
        guard let data = value.data(using: .utf8) else { return false }

        // Delete existing entry (ignore status since it may not exist)
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add new entry
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
    }

    /// Delete a generic password via `SecItemDelete`.
    @discardableResult
    private static func nativeDeleteKey(service: String, account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
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
    @discardableResult
    private static func cliSetKey(service: String, account: String, value: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    /// Delete a generic password via `security delete-generic-password`.
    @discardableResult
    private static func cliDeleteKey(service: String, account: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["delete-generic-password", "-s", service, "-a", account]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    // MARK: - Migration

    /// One-time migration from the legacy keychain entry to the daemon-shared entry.
    /// Returns the current anthropic key if it was read during the check, so the
    /// caller can reuse it without a second CLI invocation.
    @discardableResult
    private static func migrateIfNeeded() -> String? {
        // Skip if new entry already exists — return the value we just read
        if let existing = nativeGetKey(service: service, account: "anthropic") { return existing }

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
              let key = String(data: data, encoding: .utf8) else { return nil }

        // Write to new entry via native SecItem API (prompt-free)
        nativeSetKey(service: service, account: "anthropic", value: key)

        // Delete legacy entry
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: legacyService,
            kSecAttrAccount as String: legacyAccount
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        return key
    }

    /// One-time migration from CLI-created keychain items to native SecItem entries.
    /// CLI-created items are owned by `/usr/bin/security` and trigger macOS authorization
    /// prompts; native entries are owned by the app and are prompt-free.
    private static func migrateCliToNativeIfNeeded() {
        guard !UserDefaults.standard.bool(forKey: "keychain-native-migration-done") else { return }

        let providers = [
            "anthropic", "openai", "gemini", "fireworks",
            "brave", "perplexity", "elevenlabs", "openrouter", "ollama"
        ]

        for provider in providers {
            if let value = cliGetKey(service: service, account: provider) {
                nativeSetKey(service: service, account: provider, value: value)
                cliDeleteKey(service: service, account: provider)
            }
        }

        UserDefaults.standard.set(true, forKey: "keychain-native-migration-done")
    }

    private static func notifyKeyDidChange() {
        NotificationCenter.default.post(name: .apiKeyManagerDidChange, object: nil)
    }
}
