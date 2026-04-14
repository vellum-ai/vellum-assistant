#if os(macOS)
import CryptoKit
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "SigningIdentityManager"
)

/// Manages the Ed25519 signing identity stored on disk in ~/.vellum/protected/.
/// Previously used the macOS Keychain, which triggers repeated authorization
/// prompts with ad-hoc code-signed builds.
///
/// Uses `actor` isolation instead of `@MainActor` so that file I/O
/// (loading/saving the key) does not block the main thread.
public actor SigningIdentityManager {
    public static let shared = SigningIdentityManager()

    /// File path for the signing key, resolved via `VellumPaths.current`.
    private var keyFilePath: URL {
        VellumPaths.current.signingKeyFile
    }

    /// Cached private key to avoid repeated file reads.
    private var cachedKey: Curve25519.Signing.PrivateKey?

    /// Get or create the Ed25519 signing private key.
    public func getPrivateKey() throws -> Curve25519.Signing.PrivateKey {
        if let cached = cachedKey {
            return cached
        }

        // Try to load from file
        if let key = try loadFromFile() {
            cachedKey = key
            return key
        }

        // Generate a new key and store it
        let key = Curve25519.Signing.PrivateKey()
        try saveToFile(key)
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

    // MARK: - File Storage

    private func loadFromFile() throws -> Curve25519.Signing.PrivateKey? {
        let path = keyFilePath
        guard FileManager.default.fileExists(atPath: path.path) else {
            return nil
        }
        let data = try Data(contentsOf: path)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
    }

    private func saveToFile(_ key: Curve25519.Signing.PrivateKey) throws {
        let path = keyFilePath
        let dir = path.deletingLastPathComponent()

        // Ensure directory exists with restrictive permissions
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // Set directory permissions to owner-only
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: dir.path
            )
        }

        let rawData = key.rawRepresentation
        try rawData.write(to: path, options: .atomic)
        // Set file permissions to owner read/write only
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: path.path
        )
    }
}
#endif
