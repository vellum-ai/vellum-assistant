import Foundation

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

    /// Reads the workspace config and returns the top-level dictionary.
    ///
    /// Returns an empty dictionary when the file is missing, empty,
    /// contains malformed JSON, or the root value is not an object.
    ///
    /// - Parameter path: Override the file path (useful for testing).
    public static func read(from path: String? = nil) -> [String: Any] {
        let filePath = path ?? defaultPath

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
        let filePath = path ?? defaultPath
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

    /// Sets the service mode for services that don't already have one configured.
    /// Called during onboarding (BYOK → "your-own") and managed-proxy bootstrap (→ "managed").
    /// Existing user-chosen modes are preserved so that app restarts don't reset preferences.
    public static func initializeServiceDefaults(defaultMode mode: String, into path: String? = nil) {
        let existingConfig = read(from: path)
        var services = existingConfig["services"] as? [String: Any] ?? [:]
        var changed = false

        var inference = services["inference"] as? [String: Any] ?? [:]
        if inference["mode"] == nil {
            inference["mode"] = mode
            services["inference"] = inference
            changed = true
        }

        var imageGen = services["image-generation"] as? [String: Any] ?? [:]
        if imageGen["mode"] == nil {
            imageGen["mode"] = mode
            services["image-generation"] = imageGen
            changed = true
        }

        var webSearch = services["web-search"] as? [String: Any] ?? [:]
        if webSearch["mode"] == nil {
            webSearch["mode"] = mode
            services["web-search"] = webSearch
            changed = true
        }

        var googleOAuth = services["google-oauth"] as? [String: Any] ?? [:]
        if googleOAuth["mode"] == nil {
            googleOAuth["mode"] = mode
            services["google-oauth"] = googleOAuth
            changed = true
        }

        if changed {
            try? merge(["services": services], into: path)
        }
    }
}
