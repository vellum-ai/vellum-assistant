import Foundation
import VellumAssistantShared

/// Utility for reading and writing the workspace configuration file at
/// `~/.vellum/workspace/config.json`.
///
/// All read errors (missing file, malformed JSON, non-object root) are
/// treated as recoverable — the caller simply gets an empty dictionary.
public enum WorkspaceConfigIO {

    /// Default path: `~/.vellum/workspace/config.json`.
    public static let defaultPath: String = {
        let home = NSHomeDirectory()
        return "\(home)/.vellum/workspace/config.json"
    }()

    private static let connectedAssistantIdDefaultsKey = "connectedAssistantId"

    /// Resolve the workspace config path for the currently connected assistant.
    ///
    /// Resolution order:
    /// 1. Explicit `path` argument (tests/overrides)
    /// 2. Connected assistant workspace from lockfile (`instanceDir`/`baseDataDir`)
    /// 3. Legacy default `~/.vellum/workspace/config.json`
    private static func resolvePath(_ path: String? = nil) -> String {
        if let path, !path.isEmpty {
            return path
        }
        guard let assistantId = UserDefaults.standard.string(forKey: connectedAssistantIdDefaultsKey),
              !assistantId.isEmpty,
              let assistant = LockfileAssistant.loadByName(assistantId),
              let workspaceDir = assistant.workspaceDir,
              !workspaceDir.isEmpty else {
            return defaultPath
        }
        return URL(fileURLWithPath: workspaceDir).appendingPathComponent("config.json").path
    }

    /// Reads the workspace config and returns the top-level dictionary.
    ///
    /// Returns an empty dictionary when the file is missing, empty,
    /// contains malformed JSON, or the root value is not an object.
    ///
    /// - Parameter path: Override the file path (useful for testing).
    public static func read(from path: String? = nil) -> [String: Any] {
        let filePath = resolvePath(path)

        guard FileManager.default.fileExists(atPath: filePath) else {
            return [:]
        }

        guard let data = FileManager.default.contents(atPath: filePath),
              !data.isEmpty else {
            return [:]
        }

        guard let json = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = json as? [String: Any] else {
            return [:]
        }

        return dict
    }

    /// Atomically merges the given key-value pairs into the config file.
    ///
    /// Performs a read-merge-write cycle so that keys not present in
    /// `values` are preserved. If the file or its parent directory does
    /// not exist, they are created.
    ///
    /// Atomicity is achieved by writing to a temporary file in the same
    /// directory and then renaming it over the target, so a crash mid-write
    /// cannot leave a truncated config on disk.
    ///
    /// - Parameters:
    ///   - values: Top-level keys to set or overwrite.
    ///   - path: Override the file path (useful for testing).
    /// - Throws: If serialisation or filesystem operations fail.
    public static func merge(_ values: [String: Any], into path: String? = nil) throws {
        let filePath = resolvePath(path)
        let fileURL = URL(fileURLWithPath: filePath)
        let directory = fileURL.deletingLastPathComponent()

        // Ensure the parent directory exists.
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )

        // Read existing config (empty dict on any error).
        var config = read(from: filePath)

        // Merge new values on top.
        for (key, value) in values {
            config[key] = value
        }

        let data = try JSONSerialization.data(
            withJSONObject: config,
            options: [.prettyPrinted, .sortedKeys]
        )

        // Write to a temp file in the same directory, then rename for atomicity.
        let tempURL = directory.appendingPathComponent(".\(UUID().uuidString).tmp")
        try data.write(to: tempURL)

        // Replace or move into place.
        do {
            if FileManager.default.fileExists(atPath: filePath) {
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: fileURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw error
        }
    }

    /// Service keys whose mode can be force-overwritten during bootstrap.
    static let forcibleServiceKeys = ["inference", "image-generation", "web-search"]

    /// Service keys whose mode is only set when missing (never force-overwritten).
    /// Google OAuth mode is user-selected and must survive app restarts.
    static let initOnlyServiceKeys = ["google-oauth"]

    /// Sets the service mode for services that don't already have one configured.
    /// Called during onboarding (BYOK → "your-own") and managed-proxy bootstrap (→ "managed").
    /// Existing user-chosen modes are preserved so that app restarts don't reset preferences.
    ///
    /// - Parameters:
    ///   - mode: The service mode to set (e.g. "managed", "your-own").
    ///   - force: When `true`, overwrites existing modes unconditionally for
    ///     forcible services (inference, image-generation, web-search). Init-only
    ///     services (google-oauth) are always set only when missing, regardless
    ///     of this flag.
    ///   - path: Override the file path (useful for testing).
    public static func initializeServiceDefaults(defaultMode mode: String, force: Bool = false, into path: String? = nil) {
        let existingConfig = read(from: path)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var changed = false

        for key in forcibleServiceKeys {
            var service = services[key] as? [String: Any] ?? [:]
            if force || service["mode"] == nil {
                service["mode"] = mode
                services[key] = service
                changed = true
            }
        }

        for key in initOnlyServiceKeys {
            var service = services[key] as? [String: Any] ?? [:]
            if service["mode"] == nil {
                service["mode"] = mode
                services[key] = service
                changed = true
            }
        }

        if changed {
            try? merge(["services": services], into: path)
        }
    }
}
