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
    private var mgmtServer: ExecManagementServer?

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

        await onProgress?("Preparing environment...")

        let assistantName = RandomNameGenerator.generateInstanceName(
            species: "vellum",
            explicitName: name
        )
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

        let platformURL = VellumEnvironment.current.containerPlatformURL

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
        await onProgress?("Starting container...")

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
        await onProgress?("Container started")

        // Start the management socket server so the CLI can exec into the container.
        let mgmtSocketPath = instanceDir.appendingPathComponent("mgmt.sock").path
        let server = ExecManagementServer(socketPath: mgmtSocketPath, podRuntime: runtime)
        do {
            try server.start()
            self.mgmtServer = server
        } catch {
            log.warning("Failed to start management socket: \(error.localizedDescription, privacy: .public) — exec will be unavailable")
        }

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

            let gatewayReady = await Self.waitForGatewayReady(
                gatewayURL: gatewayURL,
                onProgress: onProgress
            )
            if !gatewayReady {
                try? await runtime.stop()
                self.podRuntime = nil
                throw LauncherError.hatchFailed(
                    "Gateway did not become reachable after \(Self.gatewayReadyMaxAttempts) attempts — the container may have failed to start."
                )
            }

            let tokenLeased = await Self.leaseGuardianToken(
                gatewayURL: gatewayURL,
                assistantId: assistantName,
                bootstrapSecret: bootstrapSecret,
                onProgress: onProgress
            )
            if !tokenLeased {
                try? await runtime.stop()
                self.podRuntime = nil
                throw LauncherError.hatchFailed(
                    "Failed to initialize guardian token — the assistant runtime did not respond to bootstrap requests after \(Self.guardianInitMaxAttempts) attempts."
                )
            }
        }

        await onProgress?("Finalizing setup...")

        let hatchedAt = ISO8601DateFormatter().string(from: Date())
        Self.writeLockfileEntry(
            assistantId: assistantName,
            hatchedAt: hatchedAt,
            signingKey: signingKey,
            runtimeUrl: runtime.gatewayURL,
            mgmtSocket: mgmtSocketPath
        )
        LockfileAssistant.setActiveAssistantId(assistantName)
        log.info("Apple container '\(assistantName, privacy: .public)' is running")
    }

    /// Stops the running pod and clears state.
    func stop() async throws {
        mgmtServer?.stop()
        mgmtServer = nil
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
            onProgress?("Local build failed — will pull images from registry")
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

    /// Polls the gateway's `/healthz` endpoint until it returns HTTP 200,
    /// indicating the gateway process is accepting connections. This avoids
    /// wasting guardian init attempts while the gateway is still binding its
    /// port (which manifests as "Internet connection appears to be offline").
    private static let gatewayReadyMaxAttempts = 30
    private static let gatewayReadyRetryDelay: UInt64 = 2_000_000_000 // 2 seconds

    private static func waitForGatewayReady(
        gatewayURL: String,
        onProgress: (@MainActor (String) -> Void)?
    ) async -> Bool {
        guard let healthURL = URL(string: "\(gatewayURL)/healthz") else {
            log.error("Failed to construct gateway healthz URL")
            return false
        }

        let startTime = ContinuousClock.now
        for attempt in 1...gatewayReadyMaxAttempts {
            var request = URLRequest(url: healthURL)
            request.httpMethod = "GET"
            request.timeoutInterval = 5

            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    let elapsed = ContinuousClock.now - startTime
                    log.info("Gateway ready after \(attempt) attempt(s) (\(elapsed, privacy: .public))")
                    return true
                }
                log.info("Gateway not ready yet (attempt \(attempt)) — non-200 response")
            } catch {
                log.info("Gateway not ready yet (attempt \(attempt)): \(error.localizedDescription, privacy: .public)")
            }

            if attempt < gatewayReadyMaxAttempts {
                if attempt % 5 == 0 {
                    await onProgress?("Waiting for gateway to start (attempt \(attempt)/\(gatewayReadyMaxAttempts))...")
                }
                try? await Task.sleep(nanoseconds: gatewayReadyRetryDelay)
                guard !Task.isCancelled else { return false }
            }
        }

        let elapsed = ContinuousClock.now - startTime
        log.error("Gateway did not become ready after \(gatewayReadyMaxAttempts) attempts (\(elapsed, privacy: .public))")
        return false
    }

    /// Calls `POST /v1/guardian/init` on the gateway to bootstrap a JWT
    /// credential pair, then saves the token to the standard path so
    /// `GuardianTokenFileReader.importIfAvailable()` finds it on connect.
    ///
    /// Mirrors the CLI's `leaseGuardianToken()` in `guardian-token.ts`.
    ///
    /// The gateway proxies this request to the assistant runtime, which may
    /// still be booting after the gateway becomes healthy. We retry with
    /// exponential backoff (2s → 4s → 8s, capped at 8s) for up to 30
    /// attempts (~222s of sleep time, plus request timeouts) to
    /// accommodate slow runtime startup.
    private static let guardianInitMaxAttempts = 30
    private static let guardianInitBaseDelay: UInt64 = 2_000_000_000 // 2 seconds
    private static let guardianInitMaxDelay: UInt64 = 8_000_000_000  // 8 seconds

    @discardableResult
    private static func leaseGuardianToken(
        gatewayURL: String,
        assistantId: String,
        bootstrapSecret: String,
        onProgress: (@MainActor (String) -> Void)?
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

        let startTime = ContinuousClock.now
        var currentDelay = guardianInitBaseDelay

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
                    let elapsed = ContinuousClock.now - startTime
                    let responseBody = String(data: data, encoding: .utf8) ?? ""
                    log.warning("Guardian token lease attempt \(attempt)/\(guardianInitMaxAttempts) failed (HTTP \(httpResponse.statusCode), \(elapsed, privacy: .public)): \(responseBody, privacy: .public)")

                    // A 403 means the bootstrap secret was already consumed or
                    // is invalid — retrying won't help.
                    if httpResponse.statusCode == 403 {
                        log.error("Guardian token lease rejected with 403 — bootstrap secret consumed or invalid")
                        return false
                    }

                    if attempt < guardianInitMaxAttempts {
                        if attempt % 5 == 0 {
                            await onProgress?("Waiting for assistant runtime (attempt \(attempt)/\(guardianInitMaxAttempts))...")
                        }
                        try? await Task.sleep(nanoseconds: currentDelay)
                        guard !Task.isCancelled else { return false }
                        currentDelay = min(currentDelay * 2, guardianInitMaxDelay)
                        continue
                    }
                    log.error("Guardian token lease failed after \(guardianInitMaxAttempts) attempts (\(elapsed, privacy: .public))")
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

                do {
                    try saveGuardianTokenFile(assistantId: assistantId, tokenData: json)
                } catch {
                    log.error("Guardian token leased but failed to save: \(error.localizedDescription, privacy: .public)")
                    return false
                }
                let elapsed = ContinuousClock.now - startTime
                log.info("Guardian token leased and saved for '\(assistantId, privacy: .public)' after \(attempt) attempt(s) (\(elapsed, privacy: .public))")
                return true
            } catch {
                let elapsed = ContinuousClock.now - startTime
                log.warning("Guardian token lease attempt \(attempt)/\(guardianInitMaxAttempts) error (\(elapsed, privacy: .public)): \(error.localizedDescription, privacy: .public)")
                if attempt < guardianInitMaxAttempts {
                    if attempt % 5 == 0 {
                        await onProgress?("Waiting for assistant runtime (attempt \(attempt)/\(guardianInitMaxAttempts))...")
                    }
                    try? await Task.sleep(nanoseconds: currentDelay)
                    guard !Task.isCancelled else { return false }
                    currentDelay = min(currentDelay * 2, guardianInitMaxDelay)
                } else {
                    log.error("Guardian token lease failed after \(guardianInitMaxAttempts) attempts (\(elapsed, privacy: .public))")
                }
            }
        }
        return false
    }

    /// Saves guardian token JSON to
    /// `$XDG_CONFIG_HOME/vellum/assistants/<id>/guardian-token.json`,
    /// matching the CLI's `saveGuardianToken()` path convention.
    ///
    /// Throws if the file cannot be written — the caller must treat this
    /// as a fatal error because the bootstrap secret was already consumed.
    private static func saveGuardianTokenFile(
        assistantId: String,
        tokenData: [String: Any]
    ) throws {
        let configHome: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !xdg.isEmpty {
            configHome = xdg
        } else {
            configHome = NSHomeDirectory() + "/.config"
        }
        let dir = "\(configHome)/vellum/assistants/\(assistantId)"
        let path = "\(dir)/guardian-token.json"

        try FileManager.default.createDirectory(
            atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        let data = try JSONSerialization.data(
            withJSONObject: tokenData, options: [.prettyPrinted, .sortedKeys]
        )
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: path
        )
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
        mgmtSocket: String? = nil,
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
        if let mgmtSocket {
            newEntry["mgmtSocket"] = mgmtSocket
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
