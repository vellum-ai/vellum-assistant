import Foundation

public enum LockfilePaths {
    private static var baseDir: URL {
        if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
            return URL(fileURLWithPath: baseDir)
        }
        return URL(fileURLWithPath: NSHomeDirectory())
    }

    public static var primary: URL {
        baseDir.appendingPathComponent(".vellum.lock.json")
    }

    public static var legacy: URL {
        baseDir.appendingPathComponent(".vellum.lockfile.json")
    }

    public static var primaryPath: String { primary.path }

    /// Read and parse the lockfile, trying the primary path first,
    /// then falling back to the legacy path.
    /// Returns nil if neither file exists or both are malformed.
    public static func read() -> [String: Any]? {
        for url in [primary, legacy] {
            guard let data = try? Data(contentsOf: url),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }
            return json
        }
        return nil
    }

    /// Resolve the local gateway port: env var > lockfile > default 7830.
    public static func resolveGatewayPort() -> Int {
        if let envPort = ProcessInfo.processInfo.environment["GATEWAY_PORT"]
            ?? getenv("GATEWAY_PORT").flatMap({ String(cString: $0) }),
           let port = Int(envPort) {
            return port
        }
        if let json = read(),
           let assistants = json["assistants"] as? [[String: Any]],
           let latest = assistants.max(by: {
               ($0["hatchedAt"] as? String ?? "") < ($1["hatchedAt"] as? String ?? "")
           }),
           let resources = latest["resources"] as? [String: Any],
           let port = resources["gatewayPort"] as? Int {
            return port
        }
        return 7830
    }
}
