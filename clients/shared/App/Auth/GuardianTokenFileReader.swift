import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "GuardianTokenFileReader")

/// Reads guardian tokens persisted by the CLI at
/// `$XDG_CONFIG_HOME/vellum/assistants/<assistantId>/guardian-token.json`.
///
/// During non-local hatches (Docker, GCP, AWS, etc.) the CLI bootstraps the
/// guardian token via `POST /v1/guardian/init` and writes the result to disk.
/// The desktop app can import these credentials into `ActorTokenManager`
/// instead of repeating the HTTP bootstrap (which may fail with 403 when the
/// daemon is running inside a container).
public enum GuardianTokenFileReader {

    // MARK: - On-Disk Schema

    /// Matches the JSON shape written by the CLI's `saveGuardianToken()`.
    /// Timestamp fields may be either epoch-millisecond numbers or ISO-8601
    /// strings depending on the CLI version.
    private struct GuardianTokenFile: Decodable {
        let guardianPrincipalId: String
        let accessToken: String
        let accessTokenExpiresAt: StringOrNumber
        let refreshToken: String
        let refreshTokenExpiresAt: StringOrNumber
        let refreshAfter: StringOrNumber
        let isNew: Bool
        let deviceId: String
        let leasedAt: String
    }

    /// Decodes a JSON value that may be either a string or a number.
    private enum StringOrNumber: Decodable {
        case string(String)
        case number(Int)

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let intValue = try? container.decode(Int.self) {
                self = .number(intValue)
            } else {
                self = .string(try container.decode(String.self))
            }
        }

        var stringValue: String {
            switch self {
            case .string(let s): return s
            case .number(let n): return String(n)
            }
        }
    }

    // MARK: - Public API

    /// Attempts to load a CLI-persisted guardian token for the given assistant
    /// and populate `ActorTokenManager` with its credentials.
    ///
    /// Returns `true` if credentials were successfully imported, `false` if the
    /// file does not exist, is unreadable, or contains expired data.
    public static func importIfAvailable(assistantId: String) -> Bool {
        let path = guardianTokenPath(for: assistantId)

        guard FileManager.default.fileExists(atPath: path) else {
            log.info("No guardian token file at \(path, privacy: .public)")
            return false
        }

        guard let data = FileManager.default.contents(atPath: path) else {
            log.warning("Guardian token file exists but is unreadable: \(path, privacy: .public)")
            return false
        }

        let token: GuardianTokenFile
        do {
            token = try JSONDecoder().decode(GuardianTokenFile.self, from: data)
        } catch let decodingError as DecodingError {
            log.error("Failed to decode guardian token file at \(path, privacy: .public): \(Self.describeDecodingError(decodingError), privacy: .public)")
            return false
        } catch {
            log.error("Failed to read guardian token file at \(path, privacy: .public): \(String(describing: error), privacy: .public)")
            return false
        }

        // Convert timestamps to epoch milliseconds for ActorTokenManager.
        // The CLI may write these as epoch-millisecond numbers or ISO-8601 strings.
        guard let accessExpiresEpoch = epochMillis(from: token.accessTokenExpiresAt),
              let refreshExpiresEpoch = epochMillis(from: token.refreshTokenExpiresAt),
              let refreshAfterEpoch = epochMillis(from: token.refreshAfter) else {
            log.warning("""
                Guardian token file at \(path, privacy: .public) has unparseable timestamps — skipping import. \
                accessTokenExpiresAt=\(token.accessTokenExpiresAt.stringValue, privacy: .public), \
                refreshTokenExpiresAt=\(token.refreshTokenExpiresAt.stringValue, privacy: .public), \
                refreshAfter=\(token.refreshAfter.stringValue, privacy: .public)
                """)
            return false
        }

        // Skip if the access token is already expired.
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        if nowMs >= accessExpiresEpoch {
            log.info("Guardian token file contains expired access token — skipping import")
            return false
        }

        ActorTokenManager.storeCredentials(
            actorToken: token.accessToken,
            actorTokenExpiresAt: accessExpiresEpoch,
            refreshToken: token.refreshToken,
            refreshTokenExpiresAt: refreshExpiresEpoch,
            refreshAfter: refreshAfterEpoch,
            guardianPrincipalId: token.guardianPrincipalId
        )

        log.info("Imported guardian token from CLI file for assistant \(assistantId, privacy: .public)")
        return true
    }

    // MARK: - Path Resolution

    /// Resolves `$XDG_CONFIG_HOME/vellum/assistants/<id>/guardian-token.json`,
    /// matching the CLI's `getGuardianTokenPath()`.
    private static func guardianTokenPath(for assistantId: String) -> String {
        let configHome: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !xdg.isEmpty {
            configHome = xdg
        } else {
            configHome = NSHomeDirectory() + "/.config"
        }
        return "\(configHome)/vellum/assistants/\(assistantId)/guardian-token.json"
    }

    // MARK: - Error Descriptions

    /// Produces a human-readable summary of a `DecodingError`, including the
    /// JSON key path and expected type so schema mismatches are easy to diagnose.
    private static func describeDecodingError(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, let context):
            let path = Self.codingPath(context.codingPath)
            return "missing key '\(key.stringValue)' at \(path.isEmpty ? "root" : path)"
        case .typeMismatch(let type, let context):
            let path = Self.codingPath(context.codingPath)
            return "type mismatch for \(type) at \(path.isEmpty ? "root" : path): \(context.debugDescription)"
        case .valueNotFound(let type, let context):
            let path = Self.codingPath(context.codingPath)
            return "null value for \(type) at \(path.isEmpty ? "root" : path)"
        case .dataCorrupted(let context):
            return "corrupted data: \(context.debugDescription)"
        @unknown default:
            return String(describing: error)
        }
    }

    /// Joins a coding-key path into a dot-separated string like `"refreshToken.expiresAt"`.
    private static func codingPath(_ keys: [CodingKey]) -> String {
        keys.map(\.stringValue).joined(separator: ".")
    }

    // MARK: - Timestamp Parsing

    /// Converts a `StringOrNumber` timestamp to epoch milliseconds.
    /// Handles numeric values directly and parses ISO-8601 strings.
    private static func epochMillis(from value: StringOrNumber) -> Int? {
        switch value {
        case .number(let ms):
            return ms
        case .string(let str):
            if let date = str.iso8601Date {
                return Int(date.timeIntervalSince1970 * 1000)
            }
            if let epochMs = Int(str) {
                return epochMs
            }
            return nil
        }
    }
}
