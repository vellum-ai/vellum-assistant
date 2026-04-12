#if os(macOS)
import Foundation

/// Thread-safe mutable state for the `LockfileAssistant` file watcher.
/// Stored as a separate class because Swift structs cannot hold static
/// stored properties in extensions.
private final class LockfileWatcherState: @unchecked Sendable {
    static let shared = LockfileWatcherState()

    private let lock = NSLock()
    var fileSource: DispatchSourceFileSystemObject?
    var dirSource: DispatchSourceFileSystemObject?
    var lastKnownActiveId: String?

    func withLock<T>(_ body: (LockfileWatcherState) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(self)
    }
}

public struct ContainerInfo {
    public let assistantImage: String?
    public let gatewayImage: String?
    public let cesImage: String?
    public let assistantDigest: String?
    public let gatewayDigest: String?
    public let cesDigest: String?
    public let networkName: String?

    public init(
        assistantImage: String? = nil,
        gatewayImage: String? = nil,
        cesImage: String? = nil,
        assistantDigest: String? = nil,
        gatewayDigest: String? = nil,
        cesDigest: String? = nil,
        networkName: String? = nil
    ) {
        self.assistantImage = assistantImage
        self.gatewayImage = gatewayImage
        self.cesImage = cesImage
        self.assistantDigest = assistantDigest
        self.gatewayDigest = gatewayDigest
        self.cesDigest = cesDigest
        self.networkName = networkName
    }
}

public struct LockfileAssistant {
    public let assistantId: String
    public let runtimeUrl: String?
    public let bearerToken: String?
    public let cloud: String
    public let project: String?
    public let region: String?
    public let zone: String?
    public let instanceId: String?
    public let hatchedAt: String?
    public let baseDataDir: String?
    public let gatewayPort: Int?
    public let instanceDir: String?
    public let containerInfo: ContainerInfo?
    public let mgmtSocket: String?
    public let previousContainerInfo: ContainerInfo?
    public init(
        assistantId: String,
        runtimeUrl: String?,
        bearerToken: String?,
        cloud: String,
        project: String?,
        region: String?,
        zone: String?,
        instanceId: String?,
        hatchedAt: String?,
        baseDataDir: String?,
        gatewayPort: Int?,
        instanceDir: String?,
        containerInfo: ContainerInfo? = nil,
        mgmtSocket: String? = nil,
        previousContainerInfo: ContainerInfo? = nil
    ) {
        self.assistantId = assistantId
        self.runtimeUrl = runtimeUrl
        self.bearerToken = bearerToken
        self.cloud = cloud
        self.project = project
        self.region = region
        self.zone = zone
        self.instanceId = instanceId
        self.hatchedAt = hatchedAt
        self.baseDataDir = baseDataDir
        self.gatewayPort = gatewayPort
        self.instanceDir = instanceDir
        self.containerInfo = containerInfo
        self.mgmtSocket = mgmtSocket
        self.previousContainerInfo = previousContainerInfo
    }

    /// Whether this assistant is running remotely (not on the local machine).
    public var isRemote: Bool {
        cloud.lowercased() != "local"
    }

    /// Whether this is a platform-managed assistant.
    public var isManaged: Bool {
        let normalizedCloud = cloud.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // `platform` is a legacy managed marker used by older lockfiles.
        return normalizedCloud == "vellum" || normalizedCloud == "platform"
    }

    /// Whether this managed assistant belongs to the current build's platform environment.
    /// Local, remote, and Docker assistants always return true — they are not scoped to a
    /// specific platform. Managed assistants are compared against the build-time platform URL.
    public var isCurrentEnvironment: Bool {
        guard isManaged else { return true }
        guard let runtimeUrl = runtimeUrl, !runtimeUrl.isEmpty else { return true }
        let expected = VellumEnvironment.resolvedPlatformURL
            .lowercased().replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let actual = runtimeUrl.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        return actual == expected
    }

    /// Whether this assistant is running in Docker.
    public var isDocker: Bool {
        cloud.lowercased() == "docker"
    }

    /// Whether this assistant uses the Apple Containers runtime.
    public var isAppleContainer: Bool {
        cloud.lowercased() == "apple-container"
    }

    /// The resolved workspace directory for this assistant, accounting for both
    /// the canonical `instanceDir` (post-migration) and legacy `baseDataDir`.
    public var workspaceDir: String? {
        if let instanceDir {
            return instanceDir + "/.vellum/workspace"
        }
        if let baseDataDir {
            // Legacy: baseDataDir already includes the .vellum segment
            return baseDataDir + "/workspace"
        }
        return nil
    }

    public static func loadLatest() -> LockfileAssistant? {
        loadAll().first
    }

    /// Returns all assistant entries from the lockfile, sorted newest first.
    ///
    /// - Parameter lockfilePath: Optional explicit lockfile path. When `nil`
    ///   reads the primary path via `LockfilePaths.read()` (which includes
    ///   legacy-path migration). Tests and the connection coordinator pass
    ///   an explicit path to stay consistent with the same file the writes
    ///   target.
    public static func loadAll(lockfilePath: String? = nil) -> [LockfileAssistant] {
        let json: [String: Any]?
        if let lockfilePath {
            if let data = try? Data(contentsOf: URL(fileURLWithPath: lockfilePath)),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                json = parsed
            } else {
                json = nil
            }
        } else {
            json = LockfilePaths.read()
        }
        guard let json,
              let assistants = json["assistants"] as? [[String: Any]] else {
            return []
        }

        let sorted = assistants.sorted { a, b in
            let dateA = (a["hatchedAt"] as? String).flatMap(\.iso8601Date) ?? .distantPast
            let dateB = (b["hatchedAt"] as? String).flatMap(\.iso8601Date) ?? .distantPast
            return dateA > dateB
        }

        return sorted.compactMap { entry -> LockfileAssistant? in
            guard let assistantId = entry["assistantId"] as? String else { return nil }
            let resources = entry["resources"] as? [String: Any]
            var containerInfo: ContainerInfo? = nil
            if let ci = entry["containerInfo"] as? [String: Any] {
                containerInfo = ContainerInfo(
                    assistantImage: ci["assistantImage"] as? String,
                    gatewayImage: ci["gatewayImage"] as? String,
                    cesImage: ci["cesImage"] as? String,
                    assistantDigest: ci["assistantDigest"] as? String,
                    gatewayDigest: ci["gatewayDigest"] as? String,
                    cesDigest: ci["cesDigest"] as? String,
                    networkName: ci["networkName"] as? String
                )
            }
            var previousContainerInfo: ContainerInfo? = nil
            if let pci = entry["previousContainerInfo"] as? [String: Any] {
                previousContainerInfo = ContainerInfo(
                    assistantImage: pci["assistantImage"] as? String,
                    gatewayImage: pci["gatewayImage"] as? String,
                    cesImage: pci["cesImage"] as? String,
                    assistantDigest: pci["assistantDigest"] as? String,
                    gatewayDigest: pci["gatewayDigest"] as? String,
                    cesDigest: pci["cesDigest"] as? String,
                    networkName: pci["networkName"] as? String
                )
            }
            return LockfileAssistant(
                assistantId: assistantId,
                runtimeUrl: entry["runtimeUrl"] as? String,
                bearerToken: entry["bearerToken"] as? String,
                cloud: entry["cloud"] as? String ?? "local",
                project: entry["project"] as? String,
                region: entry["region"] as? String,
                zone: entry["zone"] as? String,
                instanceId: entry["instanceId"] as? String,
                hatchedAt: entry["hatchedAt"] as? String,
                baseDataDir: entry["baseDataDir"] as? String,
                gatewayPort: resources?["gatewayPort"] as? Int,
                instanceDir: resources?["instanceDir"] as? String,
                containerInfo: containerInfo,
                mgmtSocket: entry["mgmtSocket"] as? String,
                previousContainerInfo: previousContainerInfo
            )
        }
    }

    /// Reads the `activeAssistant` field from the lockfile, returning
    /// the assistant ID string the CLI designated as currently active.
    public static func loadActiveAssistantId() -> String? {
        guard let json = LockfilePaths.read() else { return nil }
        return json["activeAssistant"] as? String
    }

    /// Find an assistant by its ID in the lockfile.
    ///
    /// - Parameter lockfilePath: Optional explicit lockfile path. When `nil`
    ///   reads the primary path. Pass the same path the corresponding write
    ///   used so reads and writes stay in sync.
    public static func loadByName(
        _ name: String,
        lockfilePath: String? = nil
    ) -> LockfileAssistant? {
        loadAll(lockfilePath: lockfilePath).first { $0.assistantId == name }
    }

    /// Resolve the instance directory for the currently connected assistant.
    public static func connectedInstanceDir() -> String? {
        guard let id = loadActiveAssistantId() else { return nil }
        return loadByName(id)?.instanceDir
    }

    // MARK: - Active Assistant State

    /// Posted when the active assistant changes, either from a programmatic
    /// `setActiveAssistantId()` call or when the lockfile watcher detects an
    /// external modification (e.g. CLI ran `vellum use`).
    public static let activeAssistantDidChange = Notification.Name("LockfileAssistant.activeAssistantDidChange")

    /// Writes the `activeAssistant` field in the lockfile. Passing `nil`
    /// removes the field. Posts `activeAssistantDidChange` when the stored
    /// value actually changes.
    ///
    /// - Parameters:
    ///   - id: The assistant ID to designate as active, or `nil` to clear.
    ///   - lockfilePath: Override for tests; defaults to `LockfilePaths.primaryPath`.
    /// - Returns: `true` if the write succeeded (or was a no-op).
    @discardableResult
    public static func setActiveAssistantId(_ id: String?, lockfilePath: String? = nil) -> Bool {
        let path = lockfilePath ?? LockfilePaths.primaryPath
        let fileURL = URL(fileURLWithPath: path)

        var lockfile: [String: Any]
        var loadedFromPrimary = false
        if let data = try? Data(contentsOf: fileURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            lockfile = json
            loadedFromPrimary = true
        } else if lockfilePath == nil, let legacy = LockfilePaths.read() {
            lockfile = legacy
        } else {
            lockfile = [:]
        }

        let previousId = lockfile["activeAssistant"] as? String
        // Only skip the write when the value is unchanged AND the primary
        // lockfile already exists. If we loaded from the legacy fallback,
        // we still need to write so the data migrates to the primary path.
        if previousId == id, loadedFromPrimary { return true }

        let valueChanged = previousId != id

        if let id {
            lockfile["activeAssistant"] = id
        } else {
            lockfile.removeValue(forKey: "activeAssistant")
        }

        // Track whether we modified the watcher state so we can revert on failure.
        var didUpdateWatcherState = false
        var previousKnown: String?

        do {
            let data = try JSONSerialization.data(
                withJSONObject: lockfile,
                options: [.prettyPrinted, .sortedKeys]
            )
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            // Update lastKnownActiveId BEFORE writing to prevent the
            // file watcher from racing and posting a duplicate notification.
            previousKnown = LockfileWatcherState.shared.withLock { s -> String? in
                let old = s.lastKnownActiveId
                s.lastKnownActiveId = id
                return old
            }
            didUpdateWatcherState = true

            try data.write(to: fileURL, options: .atomic)

            // Only notify when the value actually changed. Migration-only
            // writes (legacy → primary with same value) should not fire.
            if valueChanged {
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: activeAssistantDidChange, object: nil)
                }
            }
            return true
        } catch {
            // Revert lastKnownActiveId on write failure so the watcher
            // can still detect the change on a future successful write.
            if didUpdateWatcherState {
                LockfileWatcherState.shared.withLock { $0.lastKnownActiveId = previousKnown }
            }
            return false
        }
    }

    /// Begins monitoring the lockfile for external changes.
    /// When the `activeAssistant` field differs from the last known value,
    /// posts `activeAssistantDidChange` on the main thread.
    ///
    /// Watches both the **lockfile itself** (for in-place overwrites) and its
    /// **parent directory** (for atomic write-to-temp + rename). When the file
    /// is deleted or renamed the file watcher is re-established automatically.
    /// Call once at app startup.
    public static func startWatching() {
        stopWatching()

        let state = LockfileWatcherState.shared
        state.withLock { $0.lastKnownActiveId = loadActiveAssistantId() }

        watchLockfile()
        watchLockfileDirectory()
    }

    /// Watch the lockfile itself for `.write` events.
    ///
    /// The entire cancel → open → create → resume → store sequence runs
    /// inside a single lock acquisition so that concurrent calls from the
    /// directory watcher (on a concurrent global queue) cannot interleave
    /// and leak a DispatchSource / file descriptor.
    private static func watchLockfile() {
        let state = LockfileWatcherState.shared
        state.withLock { s in
            s.fileSource?.cancel()
            s.fileSource = nil

            let fd = open(LockfilePaths.primaryPath, O_EVTONLY)
            guard fd >= 0 else { return }

            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .delete, .rename],
                queue: .global(qos: .utility)
            )
            source.setEventHandler {
                checkForActiveAssistantChange()
            }
            source.setCancelHandler {
                close(fd)
            }
            source.resume()
            s.fileSource = source
        }
    }

    /// Watch the lockfile's parent directory for file creation / rename.
    /// When the directory changes, re-establish the file watcher in case
    /// the lockfile was atomically replaced (new inode).
    ///
    /// Like `watchLockfile()`, the entire lifecycle runs inside a single
    /// lock acquisition to prevent concurrent `stopWatching()` from
    /// interleaving between `resume()` and store.
    private static func watchLockfileDirectory() {
        let state = LockfileWatcherState.shared
        state.withLock { s in
            s.dirSource?.cancel()
            s.dirSource = nil

            let dirPath = (LockfilePaths.primaryPath as NSString).deletingLastPathComponent
            let fd = open(dirPath, O_EVTONLY)
            guard fd >= 0 else { return }

            let source = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: .write,
                queue: .global(qos: .utility)
            )
            source.setEventHandler {
                watchLockfile()
                checkForActiveAssistantChange()
            }
            source.setCancelHandler {
                close(fd)
            }
            source.resume()
            s.dirSource = source
        }
    }

    /// Reads the current `activeAssistant` and posts a notification if it
    /// differs from the last known value.
    private static func checkForActiveAssistantChange() {
        let state = LockfileWatcherState.shared
        let currentId = loadActiveAssistantId()
        let changed: Bool = state.withLock { s in
            if currentId != s.lastKnownActiveId {
                s.lastKnownActiveId = currentId
                return true
            }
            return false
        }
        if changed {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: activeAssistantDidChange, object: nil)
            }
        }
    }

    /// Stops the lockfile watcher started by `startWatching()`.
    public static func stopWatching() {
        let state = LockfileWatcherState.shared
        state.withLock { s in
            s.fileSource?.cancel()
            s.fileSource = nil
            s.dirSource?.cancel()
            s.dirSource = nil
        }
    }

    // MARK: - Managed Entry

    /// Creates or refreshes a managed entry for the given `assistantId`.
    /// Existing entries keep their original `hatchedAt` value but have the
    /// managed runtime URL refreshed so sign-in follows the current platform.
    ///
    /// - Parameters:
    ///   - assistantId: The platform-assigned assistant UUID string.
    ///   - runtimeUrl: The platform base URL used for managed transport.
    ///   - hatchedAt: ISO-8601 timestamp of when the assistant was created.
    ///   - lockfilePath: Override for tests; defaults to `LockfilePaths.primaryPath`.
    @discardableResult
    public static func ensureManagedEntry(
        assistantId: String,
        runtimeUrl: String,
        hatchedAt: String,
        lockfilePath: String? = nil
    ) -> Bool {
        let path = lockfilePath ?? LockfilePaths.primaryPath
        let fileURL = URL(fileURLWithPath: path)

        // Read existing lockfile: try primary first, then fall back to
        // LockfilePaths.read() which includes legacy path migration.
        var lockfile: [String: Any]
        if let data = try? Data(contentsOf: fileURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            lockfile = json
        } else if lockfilePath == nil, let legacy = LockfilePaths.read() {
            // Primary doesn't exist but legacy does — migrate entries forward.
            lockfile = legacy
        } else {
            lockfile = [:]
        }

        var assistants = lockfile["assistants"] as? [[String: Any]] ?? []

        if let existingIndex = assistants.firstIndex(where: { ($0["assistantId"] as? String) == assistantId }) {
            var existingEntry = assistants[existingIndex]
            var didUpdate = false

            if (existingEntry["runtimeUrl"] as? String) != runtimeUrl {
                existingEntry["runtimeUrl"] = runtimeUrl
                didUpdate = true
            }

            if (existingEntry["cloud"] as? String) != "vellum" {
                existingEntry["cloud"] = "vellum"
                didUpdate = true
            }

            let existingHatchedAt = (existingEntry["hatchedAt"] as? String)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if existingHatchedAt?.isEmpty != false {
                existingEntry["hatchedAt"] = hatchedAt
                didUpdate = true
            }

            if !didUpdate {
                return true
            }

            assistants[existingIndex] = existingEntry
        } else {
            let newEntry: [String: Any] = [
                "assistantId": assistantId,
                "runtimeUrl": runtimeUrl,
                "cloud": "vellum",
                "hatchedAt": hatchedAt,
            ]
            assistants.append(newEntry)
        }

        lockfile["assistants"] = assistants

        // Write atomically.
        do {
            let data = try JSONSerialization.data(
                withJSONObject: lockfile,
                options: [.prettyPrinted, .sortedKeys]
            )
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
#endif
