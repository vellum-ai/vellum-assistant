#if os(macOS)
import Foundation
import Security

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

    /// Store a UTF-8 string value for a given account. Uses delete-then-add
    /// to handle both insert and update cases.
    @discardableResult
    static func set(account: String, value: String) -> Bool {
        // Delete any existing item first (ignore not-found errors).
        delete(account: account)

        guard let data = value.data(using: .utf8) else { return false }

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemAdd(attributes as CFDictionary, nil)
        return status == errSecSuccess
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
