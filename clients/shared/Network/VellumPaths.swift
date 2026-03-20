import Foundation

/// Resolve the `.vellum` data directory, honoring `BASE_DATA_DIR` when set.
public func resolveVellumDir(environment: [String: String]? = nil) -> String {
    let env = environment ?? ProcessInfo.processInfo.environment
    if let baseDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
        let resolved = baseDir == "~" ? NSHomeDirectory() : (baseDir.hasPrefix("~/") ? NSHomeDirectory() + "/" + String(baseDir.dropFirst(2)) : baseDir)
        return resolved + "/.vellum"
    }
    // Check the lockfile for instance-specific directory (multi-instance support)
    if let instanceDir = resolveInstanceDirFromLockfile() {
        return instanceDir + "/.vellum"
    }
    return NSHomeDirectory() + "/.vellum"
}

/// Read the instanceDir from the latest lockfile entry's resources.
private func resolveInstanceDirFromLockfile() -> String? {
    guard let json = LockfilePaths.read(),
          let assistants = json["assistants"] as? [[String: Any]],
          !assistants.isEmpty else {
        return nil
    }
    // Find the most recently hatched entry
    let sorted = assistants.sorted { a, b in
        let dateA = a["hatchedAt"] as? String ?? ""
        let dateB = b["hatchedAt"] as? String ?? ""
        return dateA > dateB
    }
    guard let latest = sorted.first,
          let resources = latest["resources"] as? [String: Any],
          let instanceDir = resources["instanceDir"] as? String,
          !instanceDir.isEmpty else {
        return nil
    }
    return instanceDir
}

/// Resolve the daemon PID file path, honoring `BASE_DATA_DIR`.
public func resolvePidPath(environment: [String: String]? = nil) -> String {
    return resolveVellumDir(environment: environment) + "/vellum.pid"
}
