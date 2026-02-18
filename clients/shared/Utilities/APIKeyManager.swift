import Foundation
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif
import Security

public class APIKeyManager {
    public static let shared = APIKeyManager()

    private let service = "vellum-assistant"

    private init() {}

    public func getAPIKey(provider: String = "anthropic") -> String? {
        #if targetEnvironment(simulator)
        return UserDefaults.standard.string(forKey: udKey(provider))
        #else
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
            kSecReturnData as String: true
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else {
            return nil
        }

        return key
        #endif
    }

    public func setAPIKey(_ key: String, provider: String = "anthropic") -> Bool {
        #if targetEnvironment(simulator)
        UserDefaults.standard.set(key, forKey: udKey(provider))
        return true
        #else
        guard let data = key.data(using: .utf8) else { return false }

        // Delete existing key (ignore status since key may not exist)
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        // Add new key
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        return status == errSecSuccess
        #endif
    }

    private func udKey(_ provider: String) -> String {
        "apikey_\(service)_\(provider)"
    }
}
