#if os(macOS)
import Foundation
import os

private let sharedCredentialLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "SharedFileCredentialStorage"
)

/// File-backed credential storage for shared client code that needs the same
/// persisted assistant/platform mappings as the macOS app target.
public struct SharedFileCredentialStorage: CredentialStorage {
    private static var credentialsDir: URL {
        VellumPaths.current.credentialsDir
    }

    public init() {}

    private func fileURL(for account: String) -> URL {
        let safeName = account.replacingOccurrences(
            of: "[^a-zA-Z0-9_\\-:]",
            with: "_",
            options: .regularExpression
        )
        return Self.credentialsDir.appendingPathComponent(safeName)
    }

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
            sharedCredentialLog.error("Failed to create credentials directory: \(error.localizedDescription)")
            return false
        }
    }

    public func get(account: String) -> String? {
        let url = fileURL(for: account)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return nil
        }
        do {
            let data = try Data(contentsOf: url)
            return String(data: data, encoding: .utf8)
        } catch {
            sharedCredentialLog.error("Failed to read credential: \(error.localizedDescription)")
            return nil
        }
    }

    @discardableResult
    public func set(account: String, value: String) -> Bool {
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
            sharedCredentialLog.error("Failed to write credential: \(error.localizedDescription)")
            return false
        }
    }

    @discardableResult
    public func delete(account: String) -> Bool {
        let url = fileURL(for: account)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return true
        }
        do {
            try FileManager.default.removeItem(at: url)
            return true
        } catch {
            sharedCredentialLog.error("Failed to delete credential: \(error.localizedDescription)")
            return false
        }
    }
}
#endif
