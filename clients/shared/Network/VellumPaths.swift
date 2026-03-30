import Foundation

/// Resolve the `.vellum` data directory.
///
/// When `instanceDir` is provided (e.g. from a lockfile entry's `resources.instanceDir`),
/// the vellum directory is `{instanceDir}/.vellum`. Otherwise the lockfile is checked
/// for a multi-instance directory, falling back to `~/.vellum`.
public func resolveVellumDir(instanceDir: String? = nil) -> String {
    if let dir = instanceDir?.trimmingCharacters(in: .whitespacesAndNewlines), !dir.isEmpty {
        let resolved = dir == "~" ? NSHomeDirectory() : (dir.hasPrefix("~/") ? NSHomeDirectory() + "/" + String(dir.dropFirst(2)) : dir)
        return resolved + "/.vellum"
    }
    // Check the lockfile for instance-specific directory (multi-instance support)
    if let lockfileDir = resolveInstanceDirFromLockfile() {
        return lockfileDir + "/.vellum"
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

/// Resolve the daemon PID file path for the given instance (or the default instance).
public func resolvePidPath(instanceDir: String? = nil) -> String {
    return resolveVellumDir(instanceDir: instanceDir) + "/vellum.pid"
}
