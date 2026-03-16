@preconcurrency import Foundation
import os
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AppleContainersLauncher"
)

/// Thread-safe one-shot flag used to ensure a notification observer
/// fires its continuation exactly once.
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    /// Returns `true` the first time it is called; `false` on every
    /// subsequent call.
    func trySet() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if fired { return false }
        fired = true
        return true
    }
}

// MARK: - Runtime registration

/// Notification name posted by `AppleContainersRuntime.framework` after it is
/// loaded.  The notification `object` is an
/// `AppleContainersPodRuntimeFactoryProvider` (an NSObject subclass with an
/// ObjC-compatible `makeRuntime(...)` method).
let appleContainersRuntimeDidLoadNotification = Notification.Name(
    "com.vellum.AppleContainersRuntimeDidLoad"
)

/// Thread-safe store for the `AppleContainersPodRuntimeFactoryProvider` that
/// the runtime module registers via the `com.vellum.AppleContainersRuntimeDidLoad`
/// notification.
///
/// `AppleContainersRuntimeLoader` calls `vellum_register_pod_runtime_factory`
/// via `dlsym` immediately after `dlopen` succeeds; that function posts the
/// notification which `AppleContainersLauncher` captures here.
final class AppleContainersPodRuntimeRegistry: @unchecked Sendable {
    static let shared = AppleContainersPodRuntimeRegistry()

    private let lock = NSLock()
    /// The factory provider received from the notification.  It is an
    /// `NSObject` subclass (`AppleContainersPodRuntimeFactoryProvider`) whose
    /// `makeRuntime(...)` method creates adapters.
    private var _factoryProvider: NSObject?

    private init() {}

    func registerFactoryProvider(_ provider: NSObject) {
        lock.lock()
        _factoryProvider = provider
        lock.unlock()
        log.info("AppleContainersPodRuntimeRegistry: factory provider registered (\(type(of: provider)))")
    }

    var factoryProvider: NSObject? {
        lock.lock()
        defer { lock.unlock() }
        return _factoryProvider
    }
}

// MARK: - Errors

/// Errors specific to the Apple Containers launcher.
enum AppleContainersLauncherError: LocalizedError {
    /// The `apple_containers_enabled` feature flag is off (or another
    /// availability check failed).  No lifecycle action is allowed while this
    /// error is active.
    case rolloutDisabled(AppleContainersUnavailableReason)
    /// The runtime module was not loaded or did not register a factory
    /// provider.  Should not occur in production builds that pass the
    /// availability check.
    case runtimeUnavailable
    /// The gateway did not become reachable within the readiness timeout.
    case gatewayUnreachable(port: Int, timeoutSeconds: Int)
    /// A lockfile write failed.
    case lockfileWriteFailed

    var errorDescription: String? {
        switch self {
        case .rolloutDisabled(let reason):
            return "Apple Containers is not available: \(reason.description)"
        case .runtimeUnavailable:
            return "Apple Containers pod runtime is not available."
        case .gatewayUnreachable(let port, let timeout):
            return "Gateway on port \(port) was not reachable after \(timeout) seconds."
        case .lockfileWriteFailed:
            return "Failed to write Apple Containers assistant entry to the lockfile."
        }
    }
}

// MARK: - Pod runtime handle

/// A handle to a running pod runtime instance.  Both methods dispatch to the
/// ObjC-compatible `hatchAsync:` / `retireAsync:` methods on the
/// `AppleContainersPodRuntimeAdapter` that lives in the runtime module.
@MainActor
private final class PodRuntimeHandle {
    private let adapter: NSObject

    init(adapter: NSObject) {
        self.adapter = adapter
    }

    func hatch() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let sel = NSSelectorFromString("hatchAsync:")
            guard self.adapter.responds(to: sel) else {
                continuation.resume(throwing: AppleContainersLauncherError.runtimeUnavailable)
                return
            }
            let handler: (Error?) -> Void = { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            _ = self.adapter.perform(sel, with: handler)
        }
    }

    func retire() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let sel = NSSelectorFromString("retireAsync:")
            guard self.adapter.responds(to: sel) else {
                continuation.resume(throwing: AppleContainersLauncherError.runtimeUnavailable)
                return
            }
            let handler: (Error?) -> Void = { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            _ = self.adapter.perform(sel, with: handler)
        }
    }
}

// MARK: - Launcher

/// Manages the lifecycle of an apple-containers-backed local assistant.
///
/// This launcher conforms to `LocalAssistantLauncher` and replaces the
/// CLI-based hatch path for assistants whose lockfile entry has
/// `runtimeBackend == .appleContainers`.
///
/// ### Lifecycle phases (mirrors docker.ts)
/// 1. Availability gate — `AppleContainersAvailabilityChecker` must return
///    `.available` or the call fails immediately with `.rolloutDisabled`.
/// 2. Pod hatch — creates a `PodRuntimeHandle` via the factory provider
///    registered by the runtime module, then calls `hatch()` which pulls
///    images, starts the VM, and waits for the assistant readiness sentinel.
/// 3. Gateway reachability — polls `http://localhost:<gatewayPort>/healthz`
///    until the gateway responds 200, mirroring docker.ts readiness behaviour.
/// 4. Lockfile write — writes the assistant entry (with
///    `runtimeBackend: "apple-containers"`) to the lockfile so the rest of the
///    macOS app can discover it via the normal transport path.
/// 5. Guardian token lease — best-effort; failures are logged and swallowed.
///
/// ### Feature flag
/// Every public entry point calls `requireAvailability()` first.  When the
/// flag is off the call fails with `AppleContainersLauncherError.rolloutDisabled`
/// instead of attempting a partial start.
@MainActor
final class AppleContainersLauncher: LocalAssistantLauncher {

    // MARK: - Constants

    /// How long (in seconds) to wait for the gateway /healthz before giving up.
    static let gatewayReadinessTimeoutSeconds = 120

    /// Polling interval for the gateway /healthz check.
    private static let gatewayPollIntervalNanoseconds: UInt64 = 500_000_000  // 0.5 s

    // MARK: - State

    /// The running pod handle, set after a successful hatch.
    private var activePod: PodRuntimeHandle?

    // MARK: - Notification observation

    private var runtimeLoadObserver: NSObjectProtocol?

    init() {
        // Observe the runtime-did-load notification so we capture the factory
        // provider as soon as the module is loaded.  This is called on the
        // main thread because AppDelegate initialises the launcher before
        // `setupDaemonClient()` runs.
        runtimeLoadObserver = NotificationCenter.default.addObserver(
            forName: appleContainersRuntimeDidLoadNotification,
            object: nil,
            queue: .main
        ) { notification in
            guard let provider = notification.object as? NSObject else {
                log.warning("AppleContainersLauncher: runtime-did-load notification has no provider")
                return
            }
            AppleContainersPodRuntimeRegistry.shared.registerFactoryProvider(provider)
        }
    }

    deinit {
        if let obs = runtimeLoadObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    // MARK: - LocalAssistantLauncher conformance

    /// Launch (or re-launch) an apple-containers assistant.
    ///
    /// - Parameters:
    ///   - name: The assistant ID to hatch. When `nil` a new name is generated.
    ///   - daemonOnly: Ignored for apple-containers — the pod always writes a
    ///     lockfile entry.
    ///   - restart: When `true`, stop any running pod before hatching.
    func launch(name: String?, daemonOnly: Bool, restart: Bool) async throws {
        try requireAvailability()

        let instanceName = name ?? generateInstanceName()

        if restart {
            log.info("AppleContainersLauncher: restart requested — retiring existing pod first")
            await retireActivePod()
        }

        try await hatchPod(instanceName: instanceName)
    }

    // MARK: - Availability gate

    /// Throws `.rolloutDisabled` when Apple Containers is not available on
    /// this system, and `.runtimeUnavailable` when the factory provider is
    /// absent.
    private func requireAvailability() throws {
        let availability = AppleContainersAvailabilityChecker.shared.check()
        guard availability.isAvailable else {
            if case .unavailable(let reason) = availability {
                log.error(
                    "AppleContainersLauncher: unavailable — \(reason.description, privacy: .public)"
                )
                throw AppleContainersLauncherError.rolloutDisabled(reason)
            }
            throw AppleContainersLauncherError.runtimeUnavailable
        }
    }

    // MARK: - Pod lifecycle

    /// Runs the full hatch sequence for `instanceName`.
    private func hatchPod(instanceName: String) async throws {
        log.info("AppleContainersLauncher: hatching pod '\(instanceName, privacy: .private)'")

        let params = buildDefinitionParameters(instanceName: instanceName)
        let gatewayPort = params.gatewayHostPort
        let handle = try await makePodRuntimeHandle(instanceName: instanceName, params: params)

        // Pull images, start VM, wait for assistant readiness sentinel.
        log.info("AppleContainersLauncher: starting pod for '\(instanceName, privacy: .private)'...")
        try await handle.hatch()

        // Store the running pod so we can retire it later.
        activePod = handle

        // Wait for the gateway /healthz endpoint to respond.
        // This mirrors docker.ts `tailContainerUntilReady` which only calls
        // `leaseGuardianToken` once the stack is actually reachable.
        log.info("AppleContainersLauncher: waiting for gateway on port \(gatewayPort, privacy: .public)...")
        let gatewayReady = await waitForGateway(port: gatewayPort)
        guard gatewayReady else {
            log.error("AppleContainersLauncher: gateway on port \(gatewayPort, privacy: .public) not reachable after \(Self.gatewayReadinessTimeoutSeconds, privacy: .public)s")
            throw AppleContainersLauncherError.gatewayUnreachable(
                port: gatewayPort,
                timeoutSeconds: Self.gatewayReadinessTimeoutSeconds
            )
        }

        // Write the lockfile entry so the rest of the app can discover this assistant.
        let runtimeUrl = "http://localhost:\(gatewayPort)"
        let written = writeLockfileEntry(
            instanceName: instanceName,
            runtimeUrl: runtimeUrl,
            gatewayPort: gatewayPort
        )
        guard written else {
            log.error("AppleContainersLauncher: failed to write lockfile entry for '\(instanceName, privacy: .private)'")
            throw AppleContainersLauncherError.lockfileWriteFailed
        }

        log.info("AppleContainersLauncher: pod ready for '\(instanceName, privacy: .private)' at \(runtimeUrl, privacy: .public)")

        // Best-effort guardian token lease — mirrors docker.ts leaseGuardianToken.
        await leaseGuardianTokenBestEffort(runtimeUrl: runtimeUrl)
    }

    /// Creates a `PodRuntimeHandle` using the registered factory provider.
    private func makePodRuntimeHandle(instanceName: String, params: DefinitionParameters) async throws -> PodRuntimeHandle {
        guard let provider = AppleContainersPodRuntimeRegistry.shared.factoryProvider else {
            log.error("AppleContainersLauncher: factory provider not registered — AppleContainersRuntime.framework may not have been loaded")
            throw AppleContainersLauncherError.runtimeUnavailable
        }

        // Request the adapter from the factory provider via a notification
        // pair.  The provider handles `com.vellum.AppleContainersRequestRuntime`
        // and replies with `com.vellum.AppleContainersMakeRuntime`.
        //
        // We use a `CheckedContinuation` so the main actor is suspended (not
        // blocked) while waiting for the reply, avoiding a deadlock.
        // How long to wait for the factory provider to reply before giving up.
        let makeRuntimeTimeoutSeconds: UInt64 = 5

        let adapter: NSObject = try await withCheckedThrowingContinuation { continuation in
            let replyName = Notification.Name("com.vellum.AppleContainersMakeRuntime")
            // Wrap the observer token in an @unchecked Sendable box so we can
            // safely capture and clear it inside the @Sendable observer closure.
            final class TokenBox: @unchecked Sendable { var value: NSObjectProtocol? }
            let tokenBox = TokenBox()
            let once = OnceFlag()

            tokenBox.value = NotificationCenter.default.addObserver(
                forName: replyName,
                object: provider,
                queue: .main
            ) { note in
                guard once.trySet() else { return }
                if let obs = tokenBox.value { NotificationCenter.default.removeObserver(obs) }
                if let a = note.userInfo?["adapter"] as? NSObject {
                    continuation.resume(returning: a)
                } else {
                    continuation.resume(throwing: AppleContainersLauncherError.runtimeUnavailable)
                }
            }

            // Timeout task: if handleRuntimeRequest() fails a guard and never
            // posts the reply notification the continuation would leak and
            // hatch() would hang forever.  This task resumes the continuation
            // with an error after a short deadline so the hang is bounded.
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: makeRuntimeTimeoutSeconds * 1_000_000_000)
                guard once.trySet() else { return }
                if let obs = tokenBox.value { NotificationCenter.default.removeObserver(obs) }
                log.error("AppleContainersLauncher: makePodRuntimeHandle timed out waiting for MakeRuntime reply")
                continuation.resume(throwing: AppleContainersLauncherError.runtimeUnavailable)
            }

            let userInfo: [AnyHashable: Any] = [
                "instanceName": params.instanceName,
                "version": params.version,
                "hostDataDirectory": params.hostDataDirectory,
                "hostCesBootstrapDirectory": params.hostCesBootstrapDirectory,
                "anthropicApiKey": params.anthropicApiKey as Any,
                "vellumPlatformURL": params.vellumPlatformURL as Any,
                "gatewayHostPort": params.gatewayHostPort,
            ]
            NotificationCenter.default.post(
                name: Notification.Name("com.vellum.AppleContainersRequestRuntime"),
                object: provider,
                userInfo: userInfo
            )
        }

        return PodRuntimeHandle(adapter: adapter)
    }

    /// Stops the currently active pod.  No-op when no pod is running.
    private func retireActivePod() async {
        guard let pod = activePod else {
            log.info("AppleContainersLauncher: retireActivePod — no pod running")
            return
        }
        activePod = nil
        do {
            try await pod.retire()
        } catch {
            log.error("AppleContainersLauncher: retire failed (ignored for restart): \(error, privacy: .public)")
        }
    }

    // MARK: - Gateway readiness polling

    /// Polls `http://localhost:<port>/healthz` until it returns HTTP 200 or the
    /// timeout expires.
    private func waitForGateway(port: Int) async -> Bool {
        guard let url = URL(string: "http://localhost:\(port)/healthz") else {
            return false
        }

        let deadline = Date().addingTimeInterval(TimeInterval(Self.gatewayReadinessTimeoutSeconds))

        while Date() < deadline {
            guard !Task.isCancelled else { return false }

            var request = URLRequest(url: url)
            request.timeoutInterval = 2.0

            if let (_, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse,
               http.statusCode == 200 {
                log.info("AppleContainersLauncher: gateway healthy on port \(port, privacy: .public)")
                return true
            }

            try? await Task.sleep(nanoseconds: Self.gatewayPollIntervalNanoseconds)
        }

        return false
    }

    // MARK: - Lockfile

    /// Writes an apple-containers lockfile entry for `instanceName`.
    @discardableResult
    private func writeLockfileEntry(
        instanceName: String,
        runtimeUrl: String,
        gatewayPort: Int
    ) -> Bool {
        let fileURL = LockfilePaths.primary

        var lockfile: [String: Any]
        if let data = try? Data(contentsOf: fileURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            lockfile = json
        } else if let legacy = LockfilePaths.read() {
            lockfile = legacy
        } else {
            lockfile = [:]
        }

        var assistants = lockfile["assistants"] as? [[String: Any]] ?? []
        assistants.removeAll { ($0["assistantId"] as? String) == instanceName }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        let newEntry: [String: Any] = [
            "assistantId": instanceName,
            "runtimeUrl": runtimeUrl,
            "cloud": "local",
            "hatchedAt": formatter.string(from: Date()),
            "runtimeBackend": LocalRuntimeBackend.appleContainers.rawValue,
            "resources": [
                "gatewayPort": gatewayPort,
            ],
        ]

        assistants.insert(newEntry, at: 0)
        lockfile["assistants"] = assistants

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
            log.info("AppleContainersLauncher: lockfile entry written for '\(instanceName, privacy: .private)'")
            return true
        } catch {
            log.error("AppleContainersLauncher: lockfile write failed: \(error, privacy: .public)")
            return false
        }
    }

    /// Removes the lockfile entry for `instanceName`.
    func removeLockfileEntry(for instanceName: String) {
        let fileURL = LockfilePaths.primary
        guard let json = LockfilePaths.read(),
              let assistants = json["assistants"] as? [[String: Any]] else {
            return
        }
        let filtered = assistants.filter { ($0["assistantId"] as? String) != instanceName }
        var updated = json
        updated["assistants"] = filtered
        do {
            let data = try JSONSerialization.data(
                withJSONObject: updated,
                options: [.prettyPrinted, .sortedKeys]
            )
            try data.write(to: fileURL, options: .atomic)
            log.info("AppleContainersLauncher: removed lockfile entry for '\(instanceName, privacy: .private)'")
        } catch {
            log.error("AppleContainersLauncher: failed to remove lockfile entry: \(error, privacy: .public)")
        }
    }

    // MARK: - Guardian token

    /// Attempts to lease a guardian token from the running assistant gateway.
    private func leaseGuardianTokenBestEffort(runtimeUrl: String) async {
        guard !ActorTokenManager.hasToken else {
            log.debug("AppleContainersLauncher: actor token already present — skipping lease")
            return
        }

        guard let url = URL(string: "\(runtimeUrl)/v1/guardian/init") else { return }

        log.info("AppleContainersLauncher: leasing guardian token...")

        let deviceId = PairingQRCodeSheet.computeHostId()
        let body: [String: Any] = ["platform": "macos", "deviceId": deviceId]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15.0

        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("AppleContainersLauncher: guardian token lease returned non-200 (\(statusCode, privacy: .public))")
                return
            }

            let decoded = try JSONDecoder().decode(
                DaemonClient.GuardianBootstrapResponse.self, from: data
            )

            if let refreshToken = decoded.refreshToken,
               let accessTokenExpiresAt = decoded.accessTokenExpiresAt,
               let refreshTokenExpiresAt = decoded.refreshTokenExpiresAt,
               let refreshAfter = decoded.refreshAfter {
                ActorTokenManager.storeCredentials(
                    actorToken: decoded.accessToken,
                    actorTokenExpiresAt: accessTokenExpiresAt,
                    refreshToken: refreshToken,
                    refreshTokenExpiresAt: refreshTokenExpiresAt,
                    refreshAfter: refreshAfter,
                    guardianPrincipalId: decoded.guardianPrincipalId
                )
            } else {
                ActorTokenManager.setToken(decoded.accessToken)
                ActorTokenManager.setGuardianPrincipalId(decoded.guardianPrincipalId)
                ActorTokenManager.clearRefreshMetadata()
            }

            log.info("AppleContainersLauncher: guardian token leased successfully (isNew=\(decoded.isNew, privacy: .public))")
        } catch {
            log.warning("AppleContainersLauncher: guardian token lease failed (best-effort): \(error, privacy: .public)")
        }
    }

    // MARK: - Definition parameters

    typealias DefinitionParameters = (
        instanceName: String,
        version: String,
        hostDataDirectory: URL,
        hostCesBootstrapDirectory: URL,
        anthropicApiKey: String?,
        vellumPlatformURL: String?,
        gatewayHostPort: Int
    )

    /// Resolves the stack definition parameters from the environment and
    /// UserDefaults for the given `instanceName`.
    private func buildDefinitionParameters(instanceName: String) -> DefinitionParameters {
        let env = ProcessInfo.processInfo.environment
        let homeDir = FileManager.default.homeDirectoryForCurrentUser

        let instanceDir: URL
        if let baseDataDir = env["BASE_DATA_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !baseDataDir.isEmpty {
            instanceDir = URL(fileURLWithPath: baseDataDir)
                .appendingPathComponent(".vellum")
                .appendingPathComponent("instances")
                .appendingPathComponent(instanceName)
        } else {
            instanceDir = homeDir
                .appendingPathComponent(".vellum")
                .appendingPathComponent("instances")
                .appendingPathComponent(instanceName)
        }

        let cesBootstrapDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-ces-\(instanceName)")

        let providerApiKey: String? = env["ANTHROPIC_API_KEY"]
            ?? UserDefaults.standard.string(forKey: "vellum_provider_anthropic")

        let vellumPlatformURL: String? = env["VELLUM_PLATFORM_URL"]

        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
            ?? "latest"

        let gatewayHostPort = env["GATEWAY_PORT"].flatMap(Int.init) ?? 7830

        return (
            instanceName: instanceName,
            version: version,
            hostDataDirectory: instanceDir,
            hostCesBootstrapDirectory: cesBootstrapDir,
            anthropicApiKey: providerApiKey,
            vellumPlatformURL: vellumPlatformURL,
            gatewayHostPort: gatewayHostPort
        )
    }

    /// Generates a random adjective-noun instance name matching the CLI pattern.
    private func generateInstanceName() -> String {
        let adjectives = ["amber", "brisk", "cedar", "dune", "ember", "fern", "gravel",
                          "hazel", "ivory", "jade", "kindle", "linden", "meadow", "silent"]
        let nouns = ["brook", "cliff", "dawn", "elm", "fox", "gale", "heath",
                     "oak", "pine", "reed", "sage", "thorn", "vale", "wren"]
        let adj = adjectives.randomElement() ?? "amber"
        let noun = nouns.randomElement() ?? "fox"
        return "\(adj)-\(noun)"
    }
}
