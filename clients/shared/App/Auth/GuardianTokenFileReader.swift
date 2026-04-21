import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "GuardianTokenFileReader")

/// Reads guardian tokens persisted by the CLI at
/// `$XDG_CONFIG_HOME/vellum{-env}/assistants/<assistantId>/guardian-token.json`.
///
/// During hatch, the CLI bootstraps the guardian token via
/// `POST /v1/guardian/init` and writes the result to disk. The desktop app
/// can import these credentials into `ActorTokenManager` instead of repeating
/// the HTTP bootstrap (which may fail with 403 when the daemon is running
/// inside a container, or when `guardian-init.lock` already exists on
/// bare-metal).
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

    /// Outcome of inspecting a guardian-token file on disk. Separates the
    /// decision (expose to tests) from the keychain side effect (exercised
    /// only through the public entry point). `importValid` corresponds to
    /// both tokens still valid; `importAccessExpired` corresponds to an
    /// access token past its expiry but a refresh token still inside its
    /// window — the 401 retry interceptor will rotate it on the next
    /// request, so we import it anyway instead of throwing it away.
    enum ImportDecision: Equatable {
        case skipMissingFile
        case skipUnreadableFile
        case skipUnparseableJson
        case skipUnparseableTimestamps
        case skipRefreshExpired
        case importValid(ParsedCredentials)
        case importAccessExpired(ParsedCredentials)

        var isImport: Bool {
            switch self {
            case .importValid, .importAccessExpired: return true
            default: return false
            }
        }
    }

    struct ParsedCredentials: Equatable {
        let guardianPrincipalId: String
        let accessToken: String
        let accessExpiresEpoch: Int
        let refreshToken: String
        let refreshExpiresEpoch: Int
        let refreshAfterEpoch: Int
    }

    /// Attempts to load a CLI-persisted guardian token for the given assistant
    /// and populate `ActorTokenManager` with its credentials.
    ///
    /// Returns `true` if credentials were successfully imported, `false` if the
    /// file does not exist, is unreadable, or the refresh token is already
    /// expired.
    public static func importIfAvailable(assistantId: String) -> Bool {
        let path = guardianTokenPath(for: assistantId)
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)

        let decision = decideImport(fromPath: path, nowMs: nowMs)

        switch decision {
        case .skipMissingFile:
            log.info("No guardian token file at \(path, privacy: .public)")
        case .skipUnreadableFile:
            log.warning("Guardian token file exists but is unreadable: \(path, privacy: .public)")
        case .skipUnparseableJson:
            log.error("Failed to decode guardian token file at \(path, privacy: .public)")
        case .skipUnparseableTimestamps:
            log.warning("Guardian token file at \(path, privacy: .public) has unparseable timestamps — skipping import")
        case .skipRefreshExpired:
            log.info("Guardian token file has expired refresh token — skipping import")
        case .importValid(let creds):
            ActorTokenManager.storeCredentials(
                actorToken: creds.accessToken,
                actorTokenExpiresAt: creds.accessExpiresEpoch,
                refreshToken: creds.refreshToken,
                refreshTokenExpiresAt: creds.refreshExpiresEpoch,
                refreshAfter: creds.refreshAfterEpoch,
                guardianPrincipalId: creds.guardianPrincipalId
            )
            log.info("Imported guardian token from CLI file for assistant \(assistantId, privacy: .public)")
        case .importAccessExpired(let creds):
            ActorTokenManager.storeCredentials(
                actorToken: creds.accessToken,
                actorTokenExpiresAt: creds.accessExpiresEpoch,
                refreshToken: creds.refreshToken,
                refreshTokenExpiresAt: creds.refreshExpiresEpoch,
                refreshAfter: creds.refreshAfterEpoch,
                guardianPrincipalId: creds.guardianPrincipalId
            )
            log.info("Imported guardian token from CLI file for assistant \(assistantId, privacy: .public) (access expired; refresh still valid — will rotate on first 401)")
        }

        return decision.isImport
    }

    /// Pure decision function used by the public entry point and by tests.
    /// Reads the token file at `path`, parses it, and returns whether the
    /// client should import the credentials (and in which mode). Does not
    /// mutate `ActorTokenManager` or any other process state.
    static func decideImport(fromPath path: String, nowMs: Int) -> ImportDecision {
        guard FileManager.default.fileExists(atPath: path) else {
            return .skipMissingFile
        }

        guard let data = FileManager.default.contents(atPath: path) else {
            return .skipUnreadableFile
        }

        let token: GuardianTokenFile
        do {
            token = try JSONDecoder().decode(GuardianTokenFile.self, from: data)
        } catch {
            return .skipUnparseableJson
        }

        // Convert timestamps to epoch milliseconds for ActorTokenManager.
        // The CLI may write these as epoch-millisecond numbers or ISO-8601 strings.
        guard let accessExpiresEpoch = epochMillis(from: token.accessTokenExpiresAt),
              let refreshExpiresEpoch = epochMillis(from: token.refreshTokenExpiresAt),
              let refreshAfterEpoch = epochMillis(from: token.refreshAfter) else {
            return .skipUnparseableTimestamps
        }

        // Import as long as the refresh token is still valid. An expired
        // access token is fine — the 401 retry interceptor will exchange
        // the refresh token for a fresh access token on the next request.
        // Skipping the import when only the access token is expired throws
        // away a still-valid refresh token, leaving the client with no
        // credentials and no path to recover without a manual re-pair.
        if nowMs >= refreshExpiresEpoch {
            return .skipRefreshExpired
        }

        let creds = ParsedCredentials(
            guardianPrincipalId: token.guardianPrincipalId,
            accessToken: token.accessToken,
            accessExpiresEpoch: accessExpiresEpoch,
            refreshToken: token.refreshToken,
            refreshExpiresEpoch: refreshExpiresEpoch,
            refreshAfterEpoch: refreshAfterEpoch
        )

        return nowMs >= accessExpiresEpoch
            ? .importAccessExpired(creds)
            : .importValid(creds)
    }

    /// Deletes any CLI-persisted guardian token on disk for the given
    /// assistant. Used by forced re-bootstrap paths to avoid re-importing a
    /// stale/revoked token that shares the same file. A missing file is
    /// treated as success.
    @discardableResult
    public static func deleteTokenFile(assistantId: String) -> Bool {
        let path = guardianTokenPath(for: assistantId)
        guard FileManager.default.fileExists(atPath: path) else { return true }
        do {
            try FileManager.default.removeItem(atPath: path)
            log.info("Deleted guardian token file at \(path, privacy: .public)")
            return true
        } catch {
            log.warning("Failed to delete guardian token file at \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    // MARK: - Path Resolution

    /// Resolves `$XDG_CONFIG_HOME/vellum{-env}/assistants/<id>/guardian-token.json`,
    /// matching the CLI's `getGuardianTokenPath()`.
    private static func guardianTokenPath(for assistantId: String) -> String {
        return VellumPaths.current.configDir
            .appendingPathComponent("assistants")
            .appendingPathComponent(assistantId)
            .appendingPathComponent("guardian-token.json")
            .path
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
