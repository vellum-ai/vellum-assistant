import Foundation
import os
import Security
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "AppleContainersLauncher"
)

/// Manages the lifecycle of an assistant running inside an Apple Container
/// (3-service LinuxPod VM via the Containerization framework).
///
/// Conforms to `AssistantManagementClient` so `AppDelegate.managementClient(for:)`
/// can dispatch to it for `isAppleContainer` entries.
@MainActor
final class AppleContainersLauncher: AssistantManagementClient {

    // MARK: - Errors

    enum LauncherError: LocalizedError {
        case unavailable(AppleContainersAvailabilityChecker.UnavailableReason)
        case hatchFailed(String)

        var errorDescription: String? {
            switch self {
            case .unavailable(let reason):
                switch reason {
                case .featureFlagDisabled:
                    return "Apple Containers feature flag is not enabled."
                case .unsupportedOS:
                    return "Apple Containers require macOS 26 or later."
                case .unsupportedHardware:
                    return "Apple Containers require Apple Silicon (ARM64)."
                }
            case .hatchFailed(let detail):
                return "Failed to hatch Apple Container: \(detail)"
            }
        }
    }

    // MARK: - Running State

    private var podRuntime: AppleContainersPodRuntime?

    // MARK: - Testable Hooks

    /// Checks availability. Override in tests to bypass OS/hardware gates.
    nonisolated(unsafe) static var checkAvailability: () -> AppleContainersAvailabilityChecker.Availability = {
        AppleContainersAvailabilityChecker.check()
    }

    // MARK: - AssistantManagementClient

    func hatch(name: String?, configValues: [String: String]) async throws {
        try await hatch(name: name, configValues: configValues, progress: nil)
    }

    func hatch(
        name: String?,
        configValues: [String: String],
        progress onProgress: (@MainActor (String) -> Void)?
    ) async throws {
        let availability = Self.checkAvailability()
        if case .unavailable(let reason) = availability {
            log.error("Apple Containers not available: \(String(describing: reason), privacy: .public)")
            throw LauncherError.unavailable(reason)
        }

        // TODO: Generate a unique assistant ID like the CLI does (e.g. "adjective-noun")
        // instead of using the user-facing display name. The display name can contain
        // spaces and duplicates, which makes it a poor filesystem/lockfile key.
        let assistantName = name ?? "apple-container-\(UUID().uuidString.prefix(8).lowercased())"
        let signingKey = Self.generateSigningKey()

        let kernelStore = KataKernelStore()
        let instanceDir = Self.instanceDir(for: assistantName)

        let imageRefs = VellumImageReference.defaults(version: "latest")
        let serviceImageRefs = Dictionary(
            uniqueKeysWithValues: imageRefs.map { ($0.key, $0.value.fullReference) }
        )

        let config = AppleContainersPodRuntime.Configuration(
            instanceName: assistantName,
            serviceImageRefs: serviceImageRefs,
            instanceDir: instanceDir,
            signingKey: signingKey
        )

        let runtime = AppleContainersPodRuntime(
            kernelStore: kernelStore,
            configuration: config
        )

        log.info("Hatching apple-container '\(assistantName, privacy: .public)'")

        do {
            try await runtime.start { message in
                log.info("\(message, privacy: .public)")
                await onProgress?(message)
            }
        } catch {
            // Clean up on failure.
            try? await runtime.stop()
            log.error("Apple container hatch failed: \(error.localizedDescription, privacy: .public)")
            throw LauncherError.hatchFailed(error.localizedDescription)
        }

        self.podRuntime = runtime

        let hatchedAt = ISO8601DateFormatter().string(from: Date())
        Self.writeLockfileEntry(
            assistantId: assistantName,
            hatchedAt: hatchedAt,
            signingKey: signingKey
        )
        LockfileAssistant.setActiveAssistantId(assistantName)
        log.info("Apple container '\(assistantName, privacy: .public)' is running")
    }

    /// Stops the running pod and clears state.
    func stop() async throws {
        guard let runtime = podRuntime else { return }
        podRuntime = nil
        try await runtime.stop()
    }

    // MARK: - Signing Key

    private static func generateSigningKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Paths

    private static func instanceDir(for assistantName: String) -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
            .appendingPathComponent(assistantName, isDirectory: true)
    }

    // MARK: - Lockfile

    @discardableResult
    nonisolated static func writeLockfileEntry(
        assistantId: String,
        hatchedAt: String,
        signingKey: String,
        lockfilePath: String? = nil
    ) -> Bool {
        let path = lockfilePath ?? LockfilePaths.primaryPath
        let fileURL = URL(fileURLWithPath: path)

        var lockfile: [String: Any]
        if let data = try? Data(contentsOf: fileURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            lockfile = json
        } else {
            lockfile = [:]
        }

        var assistants = lockfile["assistants"] as? [[String: Any]] ?? []

        let newEntry: [String: Any] = [
            "assistantId": assistantId,
            "cloud": "apple-container",
            "hatchedAt": hatchedAt,
            "runtimeBackend": "apple-containers",
            "resources": [
                "signingKey": signingKey,
            ],
        ]

        if let existingIndex = assistants.firstIndex(where: { ($0["assistantId"] as? String) == assistantId }) {
            assistants[existingIndex] = newEntry
        } else {
            assistants.append(newEntry)
        }

        lockfile["assistants"] = assistants

        do {
            let data = try JSONSerialization.data(
                withJSONObject: lockfile,
                options: [.prettyPrinted, .sortedKeys]
            )
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
