#if os(macOS)
import Foundation
import VellumAssistantShared
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "FileCredentialStorage"
)

/// File-based CredentialStorage for DEBUG builds.
///
/// Stores each credential as an individual file under
/// `~/.vellum/protected/credentials/` with 0600 permissions.
/// This avoids macOS Keychain authorization prompts that fire on
/// every rebuild because the binary's cdhash changes.
///
/// Mirrors the approach used by `SigningIdentityManager` which stores
/// the Ed25519 signing key on disk for the same reason.
struct FileCredentialStorage: CredentialStorage {

    private static let credentialsDir: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".vellum/protected/credentials")
    }()

    /// Returns the file URL for a given credential account name.
    /// The account name is sanitized to a safe filename by replacing
    /// characters that are not alphanumerics, hyphens, or underscores.
    private func fileURL(for account: String) -> URL {
        let safeName = account.replacingOccurrences(
            of: "[^a-zA-Z0-9_\\-]",
            with: "_",
            options: .regularExpression
        )
        return Self.credentialsDir.appendingPathComponent(safeName)
    }

    /// Ensures the credentials directory exists with 0700 permissions.
    private func ensureDirectory() -> Bool {
        let dir = Self.credentialsDir
        if FileManager.default.fileExists(atPath: dir.path) {
            return true
        }
        do {
            try FileManager.default.createDirectory(
                at: dir,
                withIntermediateDirectories: true
            )
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: dir.path
            )
            return true
        } catch {
            log.error("Failed to create credentials directory: \(error.localizedDescription)")
            return false
        }
    }

    func get(account: String) -> String? {
        let url = fileURL(for: account)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        do {
            let data = try Data(contentsOf: url)
            return String(data: data, encoding: .utf8)
        } catch {
            log.error("Failed to read credential '\(account)': \(error.localizedDescription)")
            return nil
        }
    }

    func set(account: String, value: String) -> Bool {
        guard ensureDirectory() else { return false }
        let url = fileURL(for: account)
        do {
            try value.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: url.path
            )
            return true
        } catch {
            log.error("Failed to write credential '\(account)': \(error.localizedDescription)")
            return false
        }
    }

    func delete(account: String) -> Bool {
        let url = fileURL(for: account)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return true // Already gone
        }
        do {
            try FileManager.default.removeItem(at: url)
            return true
        } catch {
            log.error("Failed to delete credential '\(account)': \(error.localizedDescription)")
            return false
        }
    }
}
#endif
