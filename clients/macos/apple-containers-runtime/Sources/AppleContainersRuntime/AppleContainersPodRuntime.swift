import Containerization
import ContainerizationOCI
import Foundation
import os

// AppleContainersPodRuntime — runs the Vellum three-service stack inside a
// single Apple Containers LinuxPod VM.
//
// This is the Apple Containers counterpart to the Docker topology in
// cli/src/lib/docker.ts.  All three services (assistant, gateway, and
// credential-executor) run as separate processes inside one Virtualization
// framework VM, sharing VM resources and communicating over the pod's
// internal localhost network rather than a Docker bridge.
//
// ### No shell-out contract
// This runtime NEVER invokes `container`, `docker`, or any helper binary to
// create or manage the pod.  All orchestration goes through the
// `Containerization` Swift framework's `LinuxPod` API directly.
//
// ### LinuxPod topology
//
//   One Virtualization.framework VM
//   ┌──────────────────────────────────────────────────┐
//   │  assistant process           (:3001 HTTP)         │
//   │  gateway process             (:7830 HTTP) ◄──────────── host port
//   │  credential-executor process (UDS)                │
//   │                                                   │
//   │  virtiofs /data              ◄── hostDataDirectory│
//   │  virtiofs /run/ces-bootstrap ◄── hostCesBootstrapDir
//   └──────────────────────────────────────────────────┘

private let runtimeLog = Logger(
    subsystem: "com.vellum.AppleContainersRuntime",
    category: "AppleContainersPodRuntime"
)

private typealias ContainerMount = Containerization.Mount

// MARK: - Errors

/// Errors emitted by `AppleContainersPodRuntime`.
public enum AppleContainersPodRuntimeError: LocalizedError {
    /// One or more required host directories could not be created.
    case hostDirectorySetupFailed(path: String, underlying: Error)
    /// The OCI image pull failed for the given service.
    case imagePullFailed(service: VellumServiceName, underlying: Error)
    /// Unpacking a container image's rootfs failed.
    case rootfsUnpackFailed(service: VellumServiceName, underlying: Error)
    /// The pod failed to start.
    case podStartFailed(underlying: Error)
    /// The assistant process did not emit the readiness sentinel within the
    /// allowed timeout.
    case readinessTimeout(seconds: Int)
    /// The assistant container exited before emitting the readiness sentinel.
    case containerExitedBeforeReady

    public var errorDescription: String? {
        switch self {
        case .hostDirectorySetupFailed(let path, let err):
            return "Could not create host directory '\(path)': \(err.localizedDescription)"
        case .imagePullFailed(let service, let err):
            return "Failed to pull image for \(service.rawValue): \(err.localizedDescription)"
        case .rootfsUnpackFailed(let service, let err):
            return "Failed to unpack rootfs for \(service.rawValue): \(err.localizedDescription)"
        case .podStartFailed(let err):
            return "Pod failed to start: \(err.localizedDescription)"
        case .readinessTimeout(let seconds):
            return "Assistant did not become ready within \(seconds) seconds."
        case .containerExitedBeforeReady:
            return "Assistant container exited before emitting the readiness sentinel."
        }
    }
}

// MARK: - Runtime

/// Orchestrates the Vellum three-service stack inside a single `LinuxPod` VM
/// using Apple's Containerization framework.
///
/// ### Lifecycle
/// ```swift
/// let runtime = AppleContainersPodRuntime(
///     definition: stackDef,
///     kernelStore: kernelStore
/// )
/// try await runtime.hatch()   // pulls images, starts pod, waits for readiness
/// try await runtime.retire()  // stops and removes the pod
/// ```
///
/// ### Thread safety
/// All mutable state is protected by an `NSLock`.  Containerization API calls
/// are dispatched from `Task` contexts; callers may call from any actor.
public final class AppleContainersPodRuntime: @unchecked Sendable {

    // MARK: - Constants

    /// How long (in seconds) to wait for the assistant readiness sentinel
    /// before giving up.
    public static let readinessTimeoutSeconds = 120

    /// Size of the ext4 block image used for each container rootfs (512 MiB).
    private static let rootfsBlockSizeBytes: UInt64 = 512 * 1024 * 1024

    // MARK: - Properties

    /// The stack topology this runtime will instantiate.
    public let definition: AppleContainerStackDefinition

    /// The kernel store used to locate the kata kernel and init image.
    public let kernelStore: KataKernelStore

    private let lock = NSLock()
    private var _pod: LinuxPod?

    // MARK: - Lifecycle

    public init(
        definition: AppleContainerStackDefinition,
        kernelStore: KataKernelStore
    ) {
        self.definition = definition
        self.kernelStore = kernelStore
    }

    // MARK: - Public API

    /// Pulls OCI images, assembles the pod, and waits until the assistant
    /// process emits the readiness sentinel.
    ///
    /// This method does **not** shell out to `container`, `docker`, or any
    /// other external tool.  Everything goes through `Containerization` APIs.
    ///
    /// - Throws: `AppleContainersPodRuntimeError` on any failure.
    public func hatch() async throws {
        // Ensure kernel and init images are available before doing anything
        // else.  ensureImagesReady() is idempotent — it returns immediately
        // when the images are already cached, so calling it here adds no
        // overhead on subsequent hatches.
        try await kernelStore.ensureImagesReady()

        runtimeLog.info(
            "Hatching pod for '\(self.definition.instanceName, privacy: .private)' version \(self.definition.version, privacy: .public)"
        )

        // Ensure host-side shared directories exist.
        try createHostDirectories()

        // Pull OCI images for all three service containers.
        runtimeLog.info("Pulling service images...")
        try await pullServiceImages()

        // Build the LinuxPod, register containers, start the VM.
        runtimeLog.info("Assembling and starting LinuxPod...")
        let pod = try await buildAndStartPod()

        lock.withLock {
            _pod = pod
        }

        // Wait for the assistant to signal readiness.
        // If readiness fails (timeout or early container exit), retire the VM
        // immediately so it does not hold port 7830 as an orphan.
        runtimeLog.info("Waiting for assistant readiness sentinel...")
        do {
            try await waitForReadiness()
        } catch {
            runtimeLog.error(
                "Readiness wait failed — retiring orphaned pod: \(error.localizedDescription, privacy: .public)"
            )
            try? await self.retire()
            throw error
        }

        runtimeLog.info(
            "Pod runtime ready for '\(self.definition.instanceName, privacy: .private)'"
        )
    }

    /// Stops all service processes and shuts down the pod VM.
    public func retire() async throws {
        let pod = lock.withLock { () -> LinuxPod? in
            let pod = _pod
            _pod = nil
            return pod
        }

        guard let pod else {
            runtimeLog.info("retire() called but no pod is running — no-op")
            return
        }

        runtimeLog.info(
            "Retiring pod for '\(self.definition.instanceName, privacy: .private)'"
        )
        try await pod.stop()
        runtimeLog.info("Pod retired successfully")
    }

    // MARK: - Private helpers

    /// Creates the host-side directories mounted into the pod via virtio-fs.
    private func createHostDirectories() throws {
        let fm = FileManager.default
        let dirs: [URL] = [
            definition.hostDataDirectory,
            definition.hostCesBootstrapDirectory,
        ]
        for dir in dirs {
            guard !fm.fileExists(atPath: dir.path) else { continue }
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            } catch {
                throw AppleContainersPodRuntimeError.hostDirectorySetupFailed(
                    path: dir.path, underlying: error)
            }
        }
    }

    /// Pulls the three service OCI images concurrently using the
    /// Containerization `ImageStore`.
    private func pullServiceImages() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for service in VellumServiceName.allCases {
                let ref = definition.imageReference(for: service)
                group.addTask { [weak self] in
                    guard let self else { return }
                    runtimeLog.info(
                        "Pulling \(ref.fullReference, privacy: .public) for \(service.rawValue)"
                    )
                    do {
                        _ = try await kernelStore.imageStore.pull(reference: ref.fullReference)
                    } catch {
                        throw AppleContainersPodRuntimeError.imagePullFailed(
                            service: service, underlying: error)
                    }
                }
            }
            try await group.waitForAll()
        }
    }

    /// Unpacks a service container image as an ext4 rootfs block device and
    /// returns the resulting `Mount`.
    private func unpackRootfs(for service: VellumServiceName) async throws -> ContainerMount {
        let ref = definition.imageReference(for: service)

        // Unpack destination: a per-instance, per-service subdirectory inside
        // the host data directory so rootfs files are co-located with instance
        // data and cleaned up together on retire.
        let unpackDir = definition.hostDataDirectory
            .appendingPathComponent(".rootfs", isDirectory: true)
            .appendingPathComponent(service.rawValue, isDirectory: true)

        do {
            let image = try await kernelStore.imageStore.get(reference: ref.fullReference)
            let unpacker = EXT4Unpacker(blockSizeInBytes: Self.rootfsBlockSizeBytes)
            return try await unpacker.unpack(image, for: Platform.current, at: unpackDir)
        } catch {
            throw AppleContainersPodRuntimeError.rootfsUnpackFailed(
                service: service, underlying: error)
        }
    }

    /// Builds the `LinuxPod`, registers all three service containers, and
    /// starts the VM.
    ///
    /// Returns the running pod handle on success.
    private func buildAndStartPod() async throws -> LinuxPod {
        let def = definition
        let ks = kernelStore

        // Prepare kernel and init filesystem.
        let kernel = try await ks.kernel()
        let initFsUnpackDir = def.hostDataDirectory
            .appendingPathComponent(".initfs", isDirectory: true)
        let initialFilesystem = try await ks.initFilesystem(at: initFsUnpackDir)

        // Unpack container rootfs images concurrently.
        async let assistantRootfs = unpackRootfs(for: VellumServiceName.assistant)
        async let gatewayRootfs = unpackRootfs(for: VellumServiceName.gateway)
        async let cesRootfs = unpackRootfs(for: VellumServiceName.credentialExecutor)

        let resolvedAssistantRootfs = try await assistantRootfs
        let resolvedGatewayRootfs = try await gatewayRootfs
        let resolvedCesRootfs = try await cesRootfs

        let rootfsMounts: [VellumServiceName: ContainerMount] = [
            VellumServiceName.assistant: resolvedAssistantRootfs,
            .gateway: resolvedGatewayRootfs,
            .credentialExecutor: resolvedCesRootfs,
        ]

        // Build the VMM with the kata kernel and init image.
        let vmm = VZVirtualMachineManager(kernel: kernel, initialFilesystem: initialFilesystem)

        // Create the LinuxPod.
        let pod = try LinuxPod(
            "\(def.instanceName)-pod",
            vmm: vmm
        ) { podConfig in
            podConfig.cpus = 4
            podConfig.memoryInBytes = 2048 * 1024 * 1024  // 2 GiB for three services
        }

        // Virtiofs mounts shared across the assistant and gateway containers.
        // Both services need read-write access to /data.
        let sharedMounts: [ContainerMount] = [
            .share(source: def.hostDataDirectory.path,
                   destination: VellumPodMount.dataDirectory),
            .share(source: def.hostCesBootstrapDirectory.path,
                   destination: VellumPodMount.cesBootstrapDirectory),
        ]

        // The credential-executor container mounts /data read-only to match
        // the Docker topology (docker.ts mounts the data volume `:ro` for CES).
        let cesMounts: [ContainerMount] = [
            .share(source: def.hostDataDirectory.path,
                   destination: VellumPodMount.dataDirectory,
                   options: ["ro"]),
            .share(source: def.hostCesBootstrapDirectory.path,
                   destination: VellumPodMount.cesBootstrapDirectory),
        ]

        // Register the assistant container.
        //
        // stdout is piped to a line-buffered log writer so we can detect the
        // readiness sentinel without blocking the main task.
        let (assistantReader, assistantWriter) = makeLogPipe(
            prefix: def.logPrefix(for: .assistant)
        )
        try await pod.addContainer(
            "\(def.instanceName)-assistant",
            rootfs: rootfsMounts[VellumServiceName.assistant]!
        ) { containerConfig in
            containerConfig.mounts = sharedMounts + LinuxContainer.defaultMounts()
            containerConfig.process.environmentVariables = buildEnv(def.assistantEnvironment())
            containerConfig.process.stdout = assistantWriter
            containerConfig.process.stderr = assistantWriter
        }

        // Register the gateway container.
        try await pod.addContainer(
            "\(def.instanceName)-gateway",
            rootfs: rootfsMounts[VellumServiceName.gateway]!
        ) { containerConfig in
            containerConfig.mounts = sharedMounts + LinuxContainer.defaultMounts()
            containerConfig.process.environmentVariables = buildEnv(def.gatewayEnvironment())
        }

        // Register the credential-executor container.
        // /data is mounted read-only to match the Docker topology.
        try await pod.addContainer(
            "\(def.instanceName)-credential-executor",
            rootfs: rootfsMounts[VellumServiceName.credentialExecutor]!
        ) { containerConfig in
            containerConfig.mounts = cesMounts + LinuxContainer.defaultMounts()
            containerConfig.process.environmentVariables = buildEnv(def.cesEnvironment())
        }

        // Create and start all containers.
        do {
            try await pod.create()
            try await pod.startContainer("\(def.instanceName)-assistant")
            try await pod.startContainer("\(def.instanceName)-gateway")
            try await pod.startContainer("\(def.instanceName)-credential-executor")
        } catch {
            throw AppleContainersPodRuntimeError.podStartFailed(underlying: error)
        }

        // Store the reader for readiness checking.
        lock.withLock {
            _assistantLogReader = assistantReader
        }

        return pod
    }

    // MARK: - Readiness detection

    /// An async stream of lines from the assistant container's stdout/stderr.
    /// Set immediately after the pod containers are started.
    private var _assistantLogReader: AsyncStream<String>?

    /// Waits until the assistant process emits `assistantReadinessSentinel`
    /// or the timeout expires.
    private func waitForReadiness() async throws {
        let reader = lock.withLock { _assistantLogReader }

        guard let reader else { return }

        let sentinel = assistantReadinessSentinel
        let timeout = Self.readinessTimeoutSeconds

        try await withThrowingTaskGroup(of: Void.self) { group in
            // Timeout task.
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout) * 1_000_000_000)
                throw AppleContainersPodRuntimeError.readinessTimeout(seconds: timeout)
            }

            // Log-watch task — reads lines until the sentinel appears.
            // If the stream ends (container exited) before the sentinel is
            // found, throw so hatch() fails rather than silently succeeding.
            group.addTask {
                for await line in reader {
                    runtimeLog.debug(
                        "[assistant] \(line, privacy: .private)"
                    )
                    if line.contains(sentinel) {
                        runtimeLog.info("Assistant readiness sentinel received.")
                        return
                    }
                }
                // Stream ended without the sentinel — the container exited.
                runtimeLog.error("Assistant container exited before emitting readiness sentinel.")
                throw AppleContainersPodRuntimeError.containerExitedBeforeReady
            }

            // The first task to finish (readiness or timeout) cancels the other.
            try await group.next()
            group.cancelAll()
        }
    }
}

// MARK: - Private utilities

/// Converts a `[String: String]` environment dictionary to the `KEY=VALUE`
/// format expected by `LinuxProcessConfiguration.environmentVariables`.
private func buildEnv(_ dict: [String: String]) -> [String] {
    let pathEntry = "PATH=\(LinuxProcessConfiguration.defaultPath)"
    var entries: [String] = [pathEntry]
    for (key, value) in dict {
        entries.append("\(key)=\(value)")
    }
    return entries
}

/// Creates a paired producer/consumer for streaming container log lines.
///
/// Returns an `AsyncStream<String>` for the consumer and a `Writer`
/// implementation for the producer that the container's stdout/stderr can
/// write to.
private func makeLogPipe(prefix: String) -> (stream: AsyncStream<String>, writer: any Writer) {
    let (stream, continuation) = AsyncStream<String>.makeStream()
    let writer: any Writer = LineBufferedWriter(prefix: prefix, continuation: continuation)
    return (stream, writer)
}

/// A `Writer` that accumulates data into lines and forwards each complete
/// line to an `AsyncStream` continuation.
private final class LineBufferedWriter: Writer, @unchecked Sendable {
    private var buffer = ""
    private let prefix: String
    private let continuation: AsyncStream<String>.Continuation
    private let lock = NSLock()

    init(prefix: String, continuation: AsyncStream<String>.Continuation) {
        self.prefix = prefix
        self.continuation = continuation
    }

    func write(_ data: Data) throws {
        guard let text = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        defer { lock.unlock() }
        buffer += text
        while let nl = buffer.firstIndex(of: "\n") {
            let line = String(buffer[buffer.startIndex..<nl])
            continuation.yield(line)
            buffer = String(buffer[buffer.index(after: nl)...])
        }
    }

    func close() throws {
        lock.lock()
        defer { lock.unlock() }
        if !buffer.isEmpty {
            continuation.yield(buffer)
            buffer = ""
        }
        continuation.finish()
    }
}

// MARK: - SystemPlatform convenience

/// The `SystemPlatform` matching the current machine's architecture.
///
/// Apple Containerization only supports Apple Silicon (arm64) for Linux VMs.
private let currentSystemPlatform: SystemPlatform = .linuxArm
