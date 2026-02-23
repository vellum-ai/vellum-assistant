import Foundation

enum LockfilePaths {
    private static var baseDir: URL {
        if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
            return URL(fileURLWithPath: baseDir)
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    static var primary: URL {
        baseDir.appendingPathComponent(".vellum.lock.json")
    }

    static var legacy: URL {
        baseDir.appendingPathComponent(".vellum.lockfile.json")
    }

    static var primaryPath: String { primary.path }

    /// Read and parse the lockfile, trying the primary path first,
    /// then falling back to the legacy path.
    /// Returns nil if neither file exists or both are malformed.
    static func read() -> [String: Any]? {
        for url in [primary, legacy] {
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            return json
        }
        return nil
    }
}
