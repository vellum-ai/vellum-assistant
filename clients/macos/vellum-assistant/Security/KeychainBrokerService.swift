#if os(macOS)
import Foundation
import os
import Security

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "KeychainBrokerService"
)

/// SecItem wrapper that performs keychain CRUD operations scoped to the
/// `vellum-assistant` service. All methods are synchronous and thread-safe
/// (SecItem APIs are thread-safe by design).
///
/// Uses `kSecAttrAccessibleAfterFirstUnlock` so secrets survive screen lock
/// without re-prompting the user. This differs from the iOS `APIKeyManager`
/// which uses `kSecAttrAccessibleWhenUnlocked`.
enum KeychainBrokerService {

    private static let serviceName = "vellum-assistant"

    // MARK: - Get

    /// Retrieve the UTF-8 string value for a given account, or nil if not found.
    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    // MARK: - Set

    /// Store a UTF-8 string value for a given account. Uses update-first
    /// with add-fallback so a transient add failure never erases an existing
    /// secret (unlike the previous delete-then-add approach).
    ///
    /// Returns `errSecSuccess` on success, or the failing `OSStatus` code.
    @discardableResult
    static func set(account: String, value: String) -> OSStatus {
        guard let data = value.data(using: .utf8) else { return errSecParam }

        // Try to update an existing item first.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
        ]
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, updateAttributes as CFDictionary)

        if updateStatus == errSecSuccess {
            return errSecSuccess
        }

        // Item doesn't exist yet — add it.
        if updateStatus == errSecItemNotFound {
            let addAttributes: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: serviceName,
                kSecAttrAccount as String: account,
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            ]
            let addStatus = SecItemAdd(addAttributes as CFDictionary, nil)
            if addStatus != errSecSuccess {
                log.error("SecItemAdd failed for account \(account, privacy: .public): OSStatus \(addStatus)")
            }
            return addStatus
        }

        log.error("SecItemUpdate failed for account \(account, privacy: .public): OSStatus \(updateStatus)")
        return updateStatus
    }

    // MARK: - Delete

    /// Delete the keychain item for a given account. Returns true on success
    /// or if the item was already absent.
    @discardableResult
    static func delete(account: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
        ]

        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // MARK: - List

    /// Return the account names of all generic-password items scoped to the
    /// `vellum-assistant` service.
    static func list() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let items = result as? [[String: Any]] else {
            return []
        }

        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}
#endif
