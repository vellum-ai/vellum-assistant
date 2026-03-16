#if os(macOS)
import Foundation

/// Which local launcher owns a `LockfileAssistant` entry.
///
/// - `process`: Standard `vellum-cli hatch` / PID-file lifecycle (default for
///   all existing and new process-backed local assistants).
/// - `appleContainers`: Reserved for the Apple Containers runtime path.
///   Lifecycle is managed by the macOS app via `LinuxPod`; the CLI must not
///   attempt PID-based operations on such entries.
public enum LocalRuntimeBackend: String {
    case process = "process"
    case appleContainers = "apple-containers"
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
    public let daemonPort: Int?
    public let gatewayPort: Int?
    public let instanceDir: String?
    /// Which local launcher owns this assistant.
    /// Defaults to `.process` when the field is absent in the lockfile.
    public let runtimeBackend: LocalRuntimeBackend

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
        daemonPort: Int?,
        gatewayPort: Int?,
        instanceDir: String?,
        runtimeBackend: LocalRuntimeBackend = .process
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
        self.daemonPort = daemonPort
        self.gatewayPort = gatewayPort
        self.instanceDir = instanceDir
        self.runtimeBackend = runtimeBackend
    }

    /// Whether this assistant is running remotely (not on the local machine).
    public var isRemote: Bool {
        cloud.lowercased() != "local"
    }

    /// Whether this is a platform-managed assistant.
    public var isManaged: Bool {
        cloud.lowercased() == "vellum"
    }

    /// Resolve the assistant's local runtime HTTP port from the lockfile when
    /// available, otherwise fall back to the current process environment.
    public func resolvedDaemonPort(environment: [String: String]? = nil) -> Int {
        if let daemonPort {
            return daemonPort
        }

        let rawPort: String?
        if let environment {
            rawPort = environment["RUNTIME_HTTP_PORT"]
        } else {
            let env = ProcessInfo.processInfo.environment
            rawPort = env["RUNTIME_HTTP_PORT"]
                ?? getenv("RUNTIME_HTTP_PORT").map { String(cString: $0) }
        }
        return rawPort.flatMap(Int.init) ?? 7821
    }

    public var localRuntimeBaseURL: String {
        "http://localhost:\(resolvedDaemonPort())"
    }

    public static func loadLatest() -> LockfileAssistant? {
        loadAll().first
    }

    /// Returns all assistant entries from the lockfile, sorted newest first.
    public static func loadAll() -> [LockfileAssistant] {
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return []
        }

        let fractionalFormatter = ISO8601DateFormatter()
        fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plainFormatter = ISO8601DateFormatter()
        plainFormatter.formatOptions = [.withInternetDateTime]

        func parseISO8601(_ s: String) -> Date? {
            fractionalFormatter.date(from: s) ?? plainFormatter.date(from: s)
        }

        let sorted = assistants.sorted { a, b in
            let dateA = (a["hatchedAt"] as? String).flatMap(parseISO8601) ?? .distantPast
            let dateB = (b["hatchedAt"] as? String).flatMap(parseISO8601) ?? .distantPast
            return dateA > dateB
        }

        return sorted.compactMap { entry -> LockfileAssistant? in
            guard let assistantId = entry["assistantId"] as? String else { return nil }
            let resources = entry["resources"] as? [String: Any]
            // Parse runtimeBackend — unknown values fall back to .process so a
            // future or mistyped value never misclassifies an entry as process-backed.
            let runtimeBackend: LocalRuntimeBackend
            if let raw = entry["runtimeBackend"] as? String,
               let parsed = LocalRuntimeBackend(rawValue: raw) {
                runtimeBackend = parsed
            } else {
                runtimeBackend = .process
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
                daemonPort: resources?["daemonPort"] as? Int,
                gatewayPort: resources?["gatewayPort"] as? Int,
                instanceDir: resources?["instanceDir"] as? String,
                runtimeBackend: runtimeBackend
            )
        }
    }

    /// Find an assistant by its ID in the lockfile.
    public static func loadByName(_ name: String) -> LockfileAssistant? {
        loadAll().first { $0.assistantId == name }
    }

    /// Creates a managed entry if no entry with the same `assistantId` exists.
    /// If one already exists, returns `true` without modifying it.
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

        // If an entry with this assistantId already exists, no-op.
        if assistants.contains(where: { ($0["assistantId"] as? String) == assistantId }) {
            return true
        }

        let newEntry: [String: Any] = [
            "assistantId": assistantId,
            "runtimeUrl": runtimeUrl,
            "cloud": "vellum",
            "hatchedAt": hatchedAt,
        ]
        assistants.append(newEntry)

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
