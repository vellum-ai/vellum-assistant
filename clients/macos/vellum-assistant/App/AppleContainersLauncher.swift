import Containerization
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
@available(macOS 26.0, *)
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
        let bootstrapSecret = Self.generateRandomHex(count: 32)

        let kernelStore = KataKernelStore()
        let instanceDir = Self.instanceDir(for: assistantName)

        let imageRefs = VellumImageReference.defaults(version: "latest")
        let serviceImageRefs = Dictionary(
            uniqueKeysWithValues: imageRefs.map { ($0.key, $0.value.fullReference) }
        )

        // In local builds, build images from local source instead of
        // pulling from Docker Hub. The images are loaded into the shared
        // ImageStore so PodRuntime finds them in cache via store.get().
        if VellumEnvironment.current == .local {
            await self.buildLocalImagesIfAvailable(
                kernelStore: kernelStore,
                imageRefs: imageRefs,
                onProgress: onProgress
            )
        }

        let platformURL = VellumEnvironment.current.platformURL

        let config = AppleContainersPodRuntime.Configuration(
            instanceName: assistantName,
            serviceImageRefs: serviceImageRefs,
            instanceDir: instanceDir,
            signingKey: signingKey,
            bootstrapSecret: bootstrapSecret,
            platformURL: platformURL
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

        // Lease a guardian token so the desktop app can authenticate with the
        // gateway. The CLI does this in hatch-local.ts after the gateway starts;
        // for apple containers we do it directly from Swift.
        //
        // This MUST succeed — the gateway is configured with a single
        // GUARDIAN_BOOTSTRAP_SECRET that is consumed on the first successful
        // call. If we fail here, the fallback path in performInitialBootstrap()
        // generates a new random secret that the gateway will reject with 403.
        if let gatewayURL = runtime.gatewayURL {
            await onProgress?("Securing connection...")
            let tokenLeased = await Self.leaseGuardianToken(
                gatewayURL: gatewayURL,
                assistantId: assistantName,
                bootstrapSecret: bootstrapSecret
            )
            if !tokenLeased {
                try? await runtime.stop()
                self.podRuntime = nil
                throw LauncherError.hatchFailed(
                    "Failed to initialize guardian token — the gateway did not respond to bootstrap requests after \(Self.guardianInitMaxAttempts) attempts."
                )
            }
        }

        let hatchedAt = ISO8601DateFormatter().string(from: Date())
        Self.writeLockfileEntry(
            assistantId: assistantName,
            hatchedAt: hatchedAt,
            signingKey: signingKey,
            runtimeUrl: runtime.gatewayURL
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

    // MARK: - Local Image Building

    /// Attempts to build service images from local source code using Docker.
    /// Falls back silently to Docker Hub pull (via PodRuntime) if any step fails.
    /// Only called when `VellumEnvironment.current == .local`.
    private func buildLocalImagesIfAvailable(
        kernelStore: KataKernelStore,
        imageRefs: [VellumServiceName: VellumImageReference],
        onProgress: (@MainActor (String) -> Void)?
    ) async {
        guard let repoRoot = LocalImageBuilder.findRepoRoot() else {
            log.info("No repo root found — will pull images from registry")
            return
        }
        guard LocalImageBuilder.hasFullSourceTree(at: repoRoot) else {
            log.info("Repo root at \(repoRoot.path, privacy: .public) has no full source tree — will pull from registry")
            return
        }
        guard await LocalImageBuilder.isDockerAvailable() else {
            log.info("Docker not available — will pull images from registry")
            return
        }

        log.info("Building images locally from \(repoRoot.path, privacy: .public)")
        do {
            let imageStore = try await kernelStore.makeImageStore()
            try await LocalImageBuilder.buildAndLoadImages(
                repoRoot: repoRoot,
                imageRefs: imageRefs,
                store: imageStore,
                progress: { message in
                    log.info("\(message, privacy: .public)")
                    await onProgress?(message)
                }
            )
        } catch {
            log.warning("Local image build failed, falling back to registry pull: \(error.localizedDescription, privacy: .public)")
            await onProgress?("Local build failed — will pull images from registry")
        }
    }

    // MARK: - Cryptographic Helpers

    private static func generateSigningKey() -> String {
        generateRandomHex(count: 32)
    }

    private static func generateRandomHex(count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Guardian Token

    /// Calls `POST /v1/guardian/init` on the gateway to bootstrap a JWT
    /// credential pair, then saves the token to the standard path so
    /// `GuardianTokenFileReader.importIfAvailable()` finds it on connect.
    ///
    /// Mirrors the CLI's `leaseGuardianToken()` in `guardian-token.ts`.
    private static let guardianInitMaxAttempts = 10
    private static let guardianInitRetryDelay: UInt64 = 2_000_000_000 // 2 seconds

    @discardableResult
    private static func leaseGuardianToken(
        gatewayURL: String,
        assistantId: String,
        bootstrapSecret: String
    ) async -> Bool {
        let deviceId = HostIdComputer.computeHostId()
        let body: [String: Any] = [
            "platform": "macos",
            "deviceId": deviceId,
        ]

        guard let url = URL(string: "\(gatewayURL)/v1/guardian/init"),
              let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            log.error("Failed to construct guardian/init request")
            return false
        }

        // The gateway may still be booting inside the container after
        // PodRuntime.start() returns. Retry with back-off until it responds.
        for attempt in 1...guardianInitMaxAttempts {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = jsonData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(bootstrapSecret, forHTTPHeaderField: "x-bootstrap-secret")
            request.timeoutInterval = 10

            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    log.error("Guardian token lease: non-HTTP response")
                    return false
                }
                guard httpResponse.statusCode == 200 else {
                    let body = String(data: data, encoding: .utf8) ?? ""
                    log.warning("Guardian token lease attempt \(attempt) failed (HTTP \(httpResponse.statusCode)): \(body, privacy: .public)")
                    if attempt < guardianInitMaxAttempts {
                        try? await Task.sleep(nanoseconds: guardianInitRetryDelay)
                        continue
                    }
                    log.error("Guardian token lease failed after \(guardianInitMaxAttempts) attempts")
                    return false
                }

                // Parse the response and save to the standard guardian token path.
                // Use try? to avoid falling into the catch block — the gateway
                // already consumed the one-time bootstrap secret on 200, so
                // retrying would fail with 403.
                guard var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    log.error("Guardian token lease: failed to parse response JSON")
                    return false
                }
                json["deviceId"] = deviceId
                json["leasedAt"] = ISO8601DateFormatter().string(from: Date())

                saveGuardianTokenFile(assistantId: assistantId, tokenData: json)
                log.info("Guardian token leased and saved for '\(assistantId, privacy: .public)'")
                return true
            } catch {
                log.warning("Guardian token lease attempt \(attempt) error: \(error.localizedDescription, privacy: .public)")
                if attempt < guardianInitMaxAttempts {
                    try? await Task.sleep(nanoseconds: guardianInitRetryDelay)
                } else {
                    log.error("Guardian token lease failed after \(guardianInitMaxAttempts) attempts")
                }
            }
        }
        return false
    }

    /// Saves guardian token JSON to
    /// `$XDG_CONFIG_HOME/vellum/assistants/<id>/guardian-token.json`,
    /// matching the CLI's `saveGuardianToken()` path convention.
    private static func saveGuardianTokenFile(
        assistantId: String,
        tokenData: [String: Any]
    ) {
        let configHome: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !xdg.isEmpty {
            configHome = xdg
        } else {
            configHome = NSHomeDirectory() + "/.config"
        }
        let dir = "\(configHome)/vellum/assistants/\(assistantId)"
        let path = "\(dir)/guardian-token.json"

        do {
            try FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
            let data = try JSONSerialization.data(
                withJSONObject: tokenData, options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            // Restrict file permissions to owner-only read/write.
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: path
            )
        } catch {
            log.error("Failed to save guardian token to \(path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
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
        runtimeUrl: String? = nil,
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

        var newEntry: [String: Any] = [
            "assistantId": assistantId,
            "cloud": "apple-container",
            "hatchedAt": hatchedAt,
            "runtimeBackend": "apple-containers",
            "resources": [
                "signingKey": signingKey,
            ],
        ]
        if let runtimeUrl {
            newEntry["runtimeUrl"] = runtimeUrl
        }

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
