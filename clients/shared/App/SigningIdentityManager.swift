#if os(macOS)
import CryptoKit
import Foundation
import Security
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "SigningIdentityManager"
)

/// Manages the Ed25519 signing identity stored in the macOS Keychain.
/// Key is generated on first access and persisted across launches.
@MainActor
public final class SigningIdentityManager {
    public static let shared = SigningIdentityManager()

    private let service = "vellum-assistant"
    private let account = "signing-key"

    /// Cached private key to avoid repeated Keychain lookups.
    private var cachedKey: Curve25519.Signing.PrivateKey?

    /// Get or create the Ed25519 signing private key.
    public func getPrivateKey() throws -> Curve25519.Signing.PrivateKey {
        if let cached = cachedKey {
            return cached
        }

        // Try to load from Keychain
        if let key = try loadFromKeychain() {
            cachedKey = key
            return key
        }

        // Generate a new key and store it
        let key = Curve25519.Signing.PrivateKey()
        try saveToKeychain(key)
        cachedKey = key
        log.info("Generated new Ed25519 signing key")
        return key
    }

    /// Get the public key.
    public func getPublicKey() throws -> Curve25519.Signing.PublicKey {
        return try getPrivateKey().publicKey
    }

    /// Key identifier (SHA-256 fingerprint of public key, hex-encoded).
    public func getKeyId() throws -> String {
        let publicKey = try getPublicKey()
        let digest = SHA256.hash(data: publicKey.rawRepresentation)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Sign data with the signing key.
    public func sign(_ data: Data) throws -> Data {
        let signingKey = try getPrivateKey()
        return try signingKey.signature(for: data)
    }

    // MARK: - Keychain Helpers

    private func loadFromKeychain() throws -> Curve25519.Signing.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            guard let data = result as? Data else {
                log.error("Keychain returned non-data result for signing key")
                return nil
            }
            return try Curve25519.Signing.PrivateKey(rawRepresentation: data)

        case errSecItemNotFound:
            return nil

        default:
            log.error("Keychain read failed with status \(status)")
            throw KeychainError.readFailed(status)
        }
    }

    private func saveToKeychain(_ key: Curve25519.Signing.PrivateKey) throws {
        let rawData = key.rawRepresentation

        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: rawData,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]

        // Try to add; if it already exists, update it
        var status = SecItemAdd(attributes as CFDictionary, nil)

        if status == errSecDuplicateItem {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            let update: [String: Any] = [
                kSecValueData as String: rawData,
            ]
            status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        }

        guard status == errSecSuccess else {
            log.error("Keychain write failed with status \(status)")
            throw KeychainError.writeFailed(status)
        }
    }

    // MARK: - Errors

    enum KeychainError: Error, LocalizedError {
        case readFailed(OSStatus)
        case writeFailed(OSStatus)

        var errorDescription: String? {
            switch self {
            case .readFailed(let status):
                return "Failed to read signing key from Keychain (status \(status))"
            case .writeFailed(let status):
                return "Failed to write signing key to Keychain (status \(status))"
            }
        }
    }
}
#endif
