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
/// Subclasses `AssistantManagementClient` so `create(for:)` can dispatch to
/// it for `isAppleContainer` entries.
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

    override func hatch(name: String? = nil, configValues: [String: String] = [:]) async throws {
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

        onProgress?("Preparing environment...")

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
        // When local builds succeed we set skipRegistryPull so PodRuntime
        // never falls back to a Docker Hub pull.
        var builtLocally = false
        if VellumEnvironment.current == .local {
            try await self.buildLocalImages(
                kernelStore: kernelStore,
                imageRefs: imageRefs,
                onProgress: onProgress
            )
            builtLocally = true
        }

        let platformURL = VellumEnvironment.current.containerPlatformURL

        let config = AppleContainersPodRuntime.Configuration(
            instanceName: assistantName,
            serviceImageRefs: serviceImageRefs,
            instanceDir: instanceDir,
            signingKey: signingKey,
            bootstrapSecret: bootstrapSecret,
            platformURL: platformURL,
            skipRegistryPull: builtLocally
        )

        let runtime = AppleContainersPodRuntime(
            kernelStore: kernelStore,
            configuration: config
        )

        log.info("Hatching apple-container '\(assistantName, privacy: .public)'")
        onProgress?("Starting container...")

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
        onProgress?("Container started")

        // Start the management socket server so the CLI can exec into the container.
        // Unix domain sockets on macOS have a 104-byte sun_path limit.
        // The instanceDir path (~/Library/Application Support/…/apple-containers/{name}/)
        // easily exceeds that, so we place the socket in the app-support root
        // as cli.sock, cli2.sock, etc. to keep the path short.
        let mgmtSocketPath = Self.nextAvailableSocketPath()
        let server = ExecManagementServer(socketPath: mgmtSocketPath, podRuntime: runtime)
        server.onRetire = { [weak self] in
            guard let self else { throw LauncherError.hatchFailed("Launcher deallocated") }
            _ = try await self.retire()
        }
        do {
            try server.start()
            self.mgmtServer = server
        } catch {
            log.warning("Failed to start management socket: \(error.localizedDescription, privacy: .public) — exec will be unavailable")
        }

        // Write the lockfile entry early so the CLI can discover this
        // assistant immediately (e.g. `vellum ps`). The runtimeUrl is
        // already known — it is derived from the pod IP assigned during
        // start(). We will NOT update the entry again later; all fields
        // that matter are populated here.
        let previousActiveId = LockfileAssistant.loadActiveAssistantId()
        let hatchedAt = ISO8601DateFormatter().string(from: Date())
        Self.writeLockfileEntry(
            assistantId: assistantName,
            hatchedAt: hatchedAt,
            signingKey: signingKey,
            runtimeUrl: runtime.gatewayURL,
            mgmtSocket: mgmtSocketPath
        )
        LockfileAssistant.setActiveAssistantId(assistantName)

        // Lease a guardian token so the desktop app can authenticate with the
        // gateway. The CLI does this in hatch-local.ts after the gateway starts;
        // for apple containers we do it directly from Swift.
        //
        // This MUST succeed — the gateway is configured with a single
        // GUARDIAN_BOOTSTRAP_SECRET that is consumed on the first successful
        // call. If we fail here, the fallback path in performInitialBootstrap()
        // generates a new random secret that the gateway will reject with 403.
        if let gatewayURL = runtime.gatewayURL {
            onProgress?("Securing connection...")

            let gatewayReady = await Self.waitForGatewayReady(
                gatewayURL: gatewayURL,
                onProgress: onProgress
            )
            if !gatewayReady {
                Self.removeLockfileEntry(assistantId: assistantName)
                LockfileAssistant.setActiveAssistantId(previousActiveId)
                mgmtServer?.stop()
                mgmtServer = nil
                try? FileManager.default.removeItem(atPath: mgmtSocketPath)
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
                Self.removeLockfileEntry(assistantId: assistantName)
                LockfileAssistant.setActiveAssistantId(previousActiveId)
                mgmtServer?.stop()
                mgmtServer = nil
                try? FileManager.default.removeItem(atPath: mgmtSocketPath)
                try? await runtime.stop()
                self.podRuntime = nil
                throw LauncherError.hatchFailed(
                    "Failed to initialize guardian token — the assistant runtime did not respond to bootstrap requests after \(Self.guardianInitMaxAttempts) attempts."
                )
            }
        }

        onProgress?("Finalizing setup...")
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

    /// Retire an apple-container assistant: stop the pod, archive the
    /// instance directory, remove the guardian token, and clean up the
    /// lockfile entry.
    override func retire(name: String? = nil) async throws -> LockfileAssistant? {
        guard let resolvedName = name ?? LockfileAssistant.loadActiveAssistantId() else {
            throw ManagementClientError.noActiveAssistant
        }

        log.info("Retiring apple-container '\(resolvedName, privacy: .public)'")

        // 1. Stop the running pod and management socket.
        //    Continue cleanup even if stop fails (e.g. pod already stopped,
        //    transient runtime error) so we don't leave stale state.
        do {
            try await stop()
        } catch {
            log.warning("Pod stop failed during retire: \(error.localizedDescription, privacy: .public) — continuing cleanup")
        }

        // 2. Archive the instance directory (best-effort — failures must not
        //    prevent guardian token and lockfile cleanup below).
        let dir = Self.instanceDir(for: resolvedName)
        do {
            if FileManager.default.fileExists(atPath: dir.path) {
                let archiveDir = Self.retiredArchiveDir()
                try FileManager.default.createDirectory(
                    at: archiveDir, withIntermediateDirectories: true
                )
                let timestamp = ISO8601DateFormatter().string(from: Date())
                    .replacingOccurrences(of: ":", with: "-")
                let archivePath = archiveDir.appendingPathComponent("\(resolvedName)-\(timestamp).tar.gz")
                let archivingDir = archiveDir.appendingPathComponent("\(resolvedName)-archiving")

                // Move the instance directory to the archiving path so the
                // original path is immediately available for a fresh hatch.
                do {
                    try FileManager.default.moveItem(at: dir, to: archivingDir)
                } catch {
                    log.warning("Failed to stage instance directory for archive: \(error.localizedDescription, privacy: .public) — removing in place")
                    try? FileManager.default.removeItem(at: dir)
                }

                // Compress in the background and clean up the archiving directory.
                if FileManager.default.fileExists(atPath: archivingDir.path) {
                    let tarCmd = [
                        "tar", "czf", archivePath.path,
                        "-C", archiveDir.path,
                        archivingDir.lastPathComponent,
                    ]
                    let tarProcess = Process()
                    tarProcess.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                    tarProcess.arguments = tarCmd
                    tarProcess.standardOutput = FileHandle.nullDevice
                    tarProcess.standardError = FileHandle.nullDevice
                    do {
                        // Set handler BEFORE run() to avoid a race where the
                        // process exits before terminationHandler is set.
                        tarProcess.terminationHandler = { _ in
                            try? FileManager.default.removeItem(at: archivingDir)
                        }
                        try tarProcess.run()
                        log.info("Archiving instance to \(archivePath.path, privacy: .public) in the background")
                    } catch {
                        log.warning("Failed to start archive: \(error.localizedDescription, privacy: .public) — cleaning up archiving dir")
                        try? FileManager.default.removeItem(at: archivingDir)
                    }
                }
            } else {
                log.info("No instance directory at \(dir.path, privacy: .public) — nothing to archive")
            }
        } catch {
            log.warning("Archiving failed: \(error.localizedDescription, privacy: .public) — continuing with cleanup")
            // Best-effort: try to remove the instance directory directly.
            try? FileManager.default.removeItem(at: dir)
        }

        // 3. Clean up the management socket file.
        //    Read the path from the lockfile entry (before we remove it) so
        //    we delete the exact cli{N}.sock that was assigned at hatch time.
        if let entry = LockfileAssistant.loadByName(resolvedName),
           let sock = entry.mgmtSocket {
            try? FileManager.default.removeItem(atPath: sock)
        }

        // 4. Deregister from the platform.
        await deregisterFromPlatformIfNeeded(runtimeAssistantId: resolvedName)

        // 5. Remove the guardian token file.
        Self.removeGuardianToken(assistantId: resolvedName)

        // 6. Remove the lockfile entry.
        Self.removeLockfileEntry(assistantId: resolvedName)

        log.info("Apple container '\(resolvedName, privacy: .public)' retired")

        // Clear the active ID and find a replacement assistant.
        return await findReplacementAfterRetire(retiredId: resolvedName)
    }

    // MARK: - Local Image Building

    /// Builds service images from local source code using Docker.
    ///
    /// This is called for local-environment hatches so engineers always run
    /// against the code on disk. Throws on failure — local builds must
    /// succeed; there is no silent fallback to Docker Hub.
    private func buildLocalImages(
        kernelStore: KataKernelStore,
        imageRefs: [VellumServiceName: VellumImageReference],
        onProgress: (@MainActor (String) -> Void)?
    ) async throws {
        guard let repoRoot = LocalImageBuilder.findRepoRoot() else {
            throw LauncherError.hatchFailed("No repo root found — cannot build images locally. Run from within the vellum-assistant repository.")
        }
        guard LocalImageBuilder.hasFullSourceTree(at: repoRoot) else {
            throw LauncherError.hatchFailed("Repo root at \(repoRoot.path) has no full source tree — cannot build images locally.")
        }
        guard await LocalImageBuilder.isDockerAvailable() else {
            throw LauncherError.hatchFailed("Docker is not available — local builds require Docker to be installed and running.")
        }

        log.info("Building images locally from \(repoRoot.path, privacy: .public)")
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
                    onProgress?("Waiting for gateway to start (attempt \(attempt)/\(gatewayReadyMaxAttempts))...")
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

        log.info("[DEBUG] Guardian token lease starting: url=\(url.absoluteString, privacy: .public), assistantId=\(assistantId, privacy: .public), maxAttempts=\(guardianInitMaxAttempts), timeout=10s")

        for attempt in 1...guardianInitMaxAttempts {
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.httpBody = jsonData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(bootstrapSecret, forHTTPHeaderField: "x-bootstrap-secret")
            request.timeoutInterval = 10

            let attemptStart = ContinuousClock.now
            log.info("[DEBUG] Guardian token lease attempt \(attempt)/\(guardianInitMaxAttempts) starting (delay so far: \(ContinuousClock.now - startTime, privacy: .public))")

            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let attemptDuration = ContinuousClock.now - attemptStart
                guard let httpResponse = response as? HTTPURLResponse else {
                    log.error("Guardian token lease: non-HTTP response")
                    return false
                }

                // Log all response headers for debugging
                let headerDict = httpResponse.allHeaderFields
                let headerStr = headerDict.map { "\($0.key): \($0.value)" }.joined(separator: ", ")
                log.info("[DEBUG] Guardian token lease attempt \(attempt) response: HTTP \(httpResponse.statusCode) in \(attemptDuration, privacy: .public), headers=[\(headerStr, privacy: .public)]")

                guard httpResponse.statusCode == 200 else {
                    let elapsed = ContinuousClock.now - startTime
                    let responseBody = String(data: data, encoding: .utf8) ?? ""
                    log.warning("Guardian token lease attempt \(attempt)/\(guardianInitMaxAttempts) failed (HTTP \(httpResponse.statusCode), \(elapsed, privacy: .public)): \(responseBody, privacy: .public)")
                    log.info("[DEBUG] Response body bytes: \(data.count), body: \(responseBody, privacy: .public)")

                    // A 403 means the bootstrap secret was already consumed or
                    // is invalid — retrying won't help.
                    if httpResponse.statusCode == 403 {
                        log.error("Guardian token lease rejected with 403 — bootstrap secret consumed or invalid")
                        return false
                    }

                    if attempt < guardianInitMaxAttempts {
                        if attempt % 5 == 0 {
                            onProgress?("Waiting for assistant runtime (attempt \(attempt)/\(guardianInitMaxAttempts))...")
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
                let attemptDuration = ContinuousClock.now - attemptStart
                log.warning("Guardian token lease attempt \(attempt)/\(guardianInitMaxAttempts) error (\(elapsed, privacy: .public)): \(error.localizedDescription, privacy: .public)")
                log.info("[DEBUG] Attempt \(attempt) threw after \(attemptDuration, privacy: .public), error type: \(String(describing: type(of: error)), privacy: .public), full: \(String(describing: error), privacy: .public)")
                if attempt < guardianInitMaxAttempts {
                    if attempt % 5 == 0 {
                        onProgress?("Waiting for assistant runtime (attempt \(attempt)/\(guardianInitMaxAttempts))...")
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

    /// Returns the next available socket path in the app-support root directory.
    /// Sockets are named cli.sock, cli2.sock, cli3.sock, … to stay within
    /// the 104-byte sun_path limit while avoiding conflicts between
    /// multiple concurrent assistants.
    static func nextAvailableSocketPath() -> String {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        let root = appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
        // cli.sock, cli2.sock, cli3.sock, …
        let base = root.appendingPathComponent("cli").path
        let first = base + ".sock"
        if !FileManager.default.fileExists(atPath: first) {
            return first
        }
        var n = 2
        while true {
            let candidate = "\(base)\(n).sock"
            if !FileManager.default.fileExists(atPath: candidate) {
                return candidate
            }
            n += 1
        }
    }

    private static func instanceDir(for assistantName: String) -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
            .appendingPathComponent(assistantName, isDirectory: true)
    }

    /// Directory where retired apple-container archives are stored.
    private static func retiredArchiveDir() -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
            .appendingPathComponent(".retired", isDirectory: true)
    }

    /// Removes the guardian token file for the given assistant.
    private static func removeGuardianToken(assistantId: String) {
        let configHome: String
        if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !xdg.isEmpty {
            configHome = xdg
        } else {
            configHome = NSHomeDirectory() + "/.config"
        }
        let tokenDir = "\(configHome)/vellum/assistants/\(assistantId)"
        let tokenPath = "\(tokenDir)/guardian-token.json"
        if FileManager.default.fileExists(atPath: tokenPath) {
            try? FileManager.default.removeItem(atPath: tokenPath)
            log.info("Removed guardian token for '\(assistantId, privacy: .public)'")
        }
        // Clean up the assistant config directory if empty.
        if let contents = try? FileManager.default.contentsOfDirectory(atPath: tokenDir),
           contents.isEmpty {
            try? FileManager.default.removeItem(atPath: tokenDir)
        }
    }

    // MARK: - Lockfile

    /// Removes a previously written lockfile entry for the given assistant.
    /// Called on hatch failure to avoid leaving stale entries that point to
    /// a stopped container.
    nonisolated static func removeLockfileEntry(
        assistantId: String,
        lockfilePath: String? = nil
    ) {
        let path = lockfilePath ?? LockfilePaths.primaryPath
        let fileURL = URL(fileURLWithPath: path)

        guard let data = try? Data(contentsOf: fileURL),
              var lockfile = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }

        var assistants = lockfile["assistants"] as? [[String: Any]] ?? []
        assistants.removeAll { ($0["assistantId"] as? String) == assistantId }
        lockfile["assistants"] = assistants

        if let updated = try? JSONSerialization.data(
            withJSONObject: lockfile, options: [.prettyPrinted, .sortedKeys]
        ) {
            try? updated.write(to: fileURL, options: .atomic)
        }
    }

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
