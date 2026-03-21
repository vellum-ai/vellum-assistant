#if os(macOS)
import Foundation

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
    public let serviceGroupVersion: String?
    public let containerInfo: ContainerInfo?
    public let previousServiceGroupVersion: String?
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
        serviceGroupVersion: String? = nil,
        containerInfo: ContainerInfo? = nil,
        previousServiceGroupVersion: String? = nil,
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
        self.serviceGroupVersion = serviceGroupVersion
        self.containerInfo = containerInfo
        self.previousServiceGroupVersion = previousServiceGroupVersion
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

    /// Whether this assistant is running in Docker.
    public var isDocker: Bool {
        cloud.lowercased() == "docker"
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
            let serviceGroupVersion = entry["serviceGroupVersion"] as? String
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
            let previousServiceGroupVersion = entry["previousServiceGroupVersion"] as? String
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
                serviceGroupVersion: serviceGroupVersion,
                containerInfo: containerInfo,
                previousServiceGroupVersion: previousServiceGroupVersion,
                previousContainerInfo: previousContainerInfo
            )
        }
    }

    /// Find an assistant by its ID in the lockfile.
    public static func loadByName(_ name: String) -> LockfileAssistant? {
        loadAll().first { $0.assistantId == name }
    }

    /// Resolve the instance directory for the currently connected assistant.
    public static func connectedInstanceDir() -> String? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return nil }
        return loadByName(id)?.instanceDir
    }

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
