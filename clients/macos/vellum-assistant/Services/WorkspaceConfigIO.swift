import Foundation

/// Read-only utility for loading the workspace configuration file at
/// `~/.vellum/workspace/config.json`.
///
/// All read errors (missing file, malformed JSON, non-object root) are
/// treated as recoverable — the caller simply gets an empty dictionary.
/// A write API will be added in a later PR.
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
}
