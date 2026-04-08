import Containerization
import ContainerizationError
import ContainerizationOCI
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "AppleContainersPodRuntime"
)

/// Runs the Vellum stack inside a single `LinuxPod` VM.
///
/// All three services can communicate over localhost,
/// similar to container networks in Docker or k8s sidecar.
final class AppleContainersPodRuntime: @unchecked Sendable {

    struct Configuration: Sendable {
        var instanceName: String
        var cpus: Int = 4
        var memoryInBytes: UInt64 = 2 * 1024 * 1024 * 1024 // 2 GiB
        var serviceImageRefs: [VellumServiceName: String]
        var instanceDir: URL
        var signingKey: String
        var bootstrapSecret: String?
        var cesServiceToken: String?
        /// Size of the ext4 rootfs block device per service container.
        var rootfsSizeInBytes: UInt64 = 512 * 1024 * 1024 // 512 MiB
    }

    private let kernelStore: KataKernelStore
    private let config: Configuration

    private let lock = NSLock()
    private var _pod: LinuxPod?
    private var _assistantLogStream: AsyncStream<String>?

    init(kernelStore: KataKernelStore, configuration: Configuration) {
        self.kernelStore = kernelStore
        self.config = configuration
    }

    // MARK: - Public API

    /// Pulls images, assembles the pod, starts all containers, and waits for
    /// the gateway to become healthy.
    func start(progress: @escaping KataKernelStore.ProgressHandler) async throws {
        log.info("Starting pod for '\(self.config.instanceName, privacy: .public)'")

        // 1. Prepare VM boot infrastructure.
        let kernelURL = try kernelStore.requireKernel()
        let kernel = Kernel(path: kernelURL, platform: .linuxArm)
        let imageStore = try await kernelStore.makeImageStore()
        let initMount = try await kernelStore.prepareInitFilesystem(
            store: imageStore, progress: progress
        )

        // 2. Pull and unpack service images.
        await progress("Pulling service images...")
        var rootfsMounts: [VellumServiceName: Containerization.Mount] = [:]
        for service in VellumServiceName.startOrder {
            guard let ref = config.serviceImageRefs[service] else {
                throw PodRuntimeError.missingImageRef(service)
            }
            let image = try await pullImage(
                reference: ref, store: imageStore, progress: progress
            )
            let rootfsPath = config.instanceDir
                .appendingPathComponent(".rootfs", isDirectory: true)
                .appendingPathComponent(service.rawValue, isDirectory: true)
            rootfsMounts[service] = try await createRootFilesystem(
                from: image, sizeInBytes: config.rootfsSizeInBytes, at: rootfsPath
            )
        }

        // 3. Create host-side shared directories.
        let workspaceDir = config.instanceDir.appendingPathComponent("workspace", isDirectory: true)
        let cesBootstrapDir = config.instanceDir.appendingPathComponent("ces-bootstrap", isDirectory: true)
        let gatewaySecurityDir = config.instanceDir.appendingPathComponent("gateway-security", isDirectory: true)
        let cesSecurityDir = config.instanceDir.appendingPathComponent("ces-security", isDirectory: true)
        for dir in [workspaceDir, cesBootstrapDir, gatewaySecurityDir, cesSecurityDir] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }

        // 4. Assemble the LinuxPod.
        await progress("Starting containers...")
        let vmm = VZVirtualMachineManager(kernel: kernel, initialFilesystem: initMount)
        let pod = try LinuxPod("\(config.instanceName)-pod", vmm: vmm) { podConfig in
            podConfig.cpus = self.config.cpus
            podConfig.memoryInBytes = self.config.memoryInBytes
        }

        // Shared virtiofs mounts.
        let sharedMounts: [Containerization.Mount] = [
            .share(source: workspaceDir.path, destination: VellumMountPaths.workspace),
            .share(source: cesBootstrapDir.path, destination: VellumMountPaths.cesBootstrap),
        ]

        // 5. Register containers.
        let (logStream, logWriter) = Self.makeLogPipe()

        // Assistant
        let assistantEnv = VellumContainerEnv.assistant(
            instanceName: config.instanceName,
            signingKey: config.signingKey,
            cesServiceToken: config.cesServiceToken
        )
        try await pod.addContainer(
            containerID(.assistant), rootfs: rootfsMounts[.assistant]!
        ) { c in
            c.mounts = sharedMounts + LinuxContainer.defaultMounts()
            c.process.environmentVariables = Self.buildEnv(assistantEnv)
            c.process.stdout = logWriter
            c.process.stderr = logWriter
        }

        // Gateway
        let gatewayEnv = VellumContainerEnv.gateway(
            signingKey: config.signingKey,
            bootstrapSecret: config.bootstrapSecret,
            cesServiceToken: config.cesServiceToken
        )
        try await pod.addContainer(
            containerID(.gateway), rootfs: rootfsMounts[.gateway]!
        ) { c in
            c.mounts = sharedMounts + [
                .share(source: gatewaySecurityDir.path, destination: VellumMountPaths.gatewaySecurityDir),
            ] + LinuxContainer.defaultMounts()
            c.process.environmentVariables = Self.buildEnv(gatewayEnv)
        }

        // Credential Executor — workspace mounted read-only to match Docker topology.
        let cesEnv = VellumContainerEnv.credentialExecutor(
            cesServiceToken: config.cesServiceToken
        )
        try await pod.addContainer(
            containerID(.credentialExecutor), rootfs: rootfsMounts[.credentialExecutor]!
        ) { c in
            c.mounts = [
                .share(source: workspaceDir.path, destination: VellumMountPaths.workspace, options: ["ro"]),
                .share(source: cesBootstrapDir.path, destination: VellumMountPaths.cesBootstrap),
                .share(source: cesSecurityDir.path, destination: VellumMountPaths.cesSecurityDir),
            ] + LinuxContainer.defaultMounts()
            c.process.environmentVariables = Self.buildEnv(cesEnv)
        }

        // 6. Create and start.
        try await pod.create()
        for service in VellumServiceName.startOrder {
            try await pod.startContainer(containerID(service))
        }

        lock.withLock {
            _pod = pod
            _assistantLogStream = logStream
        }

        log.info("Pod started for '\(self.config.instanceName, privacy: .public)'")
    }

    /// Stops all containers and shuts down the VM.
    func stop() async throws {
        let pod: LinuxPod? = lock.withLock {
            let p = _pod
            _pod = nil
            _assistantLogStream = nil
            return p
        }
        guard let pod else { return }
        log.info("Stopping pod for '\(self.config.instanceName, privacy: .public)'")
        try await pod.stop()
    }

    /// The assistant container's log stream for readiness detection.
    var assistantLogStream: AsyncStream<String>? {
        lock.withLock { _assistantLogStream }
    }

    // MARK: - Errors

    enum PodRuntimeError: LocalizedError {
        case missingImageRef(VellumServiceName)

        var errorDescription: String? {
            switch self {
            case .missingImageRef(let service):
                return "No image reference provided for \(service.rawValue)."
            }
        }
    }

    // MARK: - Private

    private func containerID(_ service: VellumServiceName) -> String {
        "\(config.instanceName)-\(service.rawValue)"
    }

    /// Converts `[String: String]` to `["KEY=VALUE"]` with a default PATH.
    private static func buildEnv(_ dict: [String: String]) -> [String] {
        var entries = ["PATH=\(LinuxProcessConfiguration.defaultPath)"]
        for (key, value) in dict {
            entries.append("\(key)=\(value)")
        }
        return entries
    }

    /// Pulls an OCI image (or returns it from cache).
    private func pullImage(
        reference: String,
        store: ImageStore,
        progress: @escaping KataKernelStore.ProgressHandler
    ) async throws -> Containerization.Image {
        do {
            return try await store.get(reference: reference)
        } catch let error as ContainerizationError where error.code == .notFound {
            await progress("Pulling \(reference)...")
            return try await store.pull(reference: reference)
        }
    }

    /// Unpacks an OCI image to an ext4 block device.
    private func createRootFilesystem(
        from image: Containerization.Image,
        sizeInBytes: UInt64,
        at path: URL
    ) async throws -> Containerization.Mount {
        do {
            let unpacker = EXT4Unpacker(blockSizeInBytes: sizeInBytes)
            return try await unpacker.unpack(image, for: .current, at: path)
        } catch let error as ContainerizationError where error.code == .exists {
            return .block(format: "ext4", source: path.path, destination: "/", options: [])
        }
    }

    /// Creates a paired async stream + writer for streaming container log lines.
    private static func makeLogPipe() -> (AsyncStream<String>, LineBufferedWriter) {
        let (stream, continuation) = AsyncStream<String>.makeStream()
        return (stream, LineBufferedWriter(continuation: continuation))
    }
}

// MARK: - LineBufferedWriter

/// A `Writer` that splits incoming data into lines and yields them to an
/// `AsyncStream` continuation.
final class LineBufferedWriter: Writer, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = ""
    private let continuation: AsyncStream<String>.Continuation

    init(continuation: AsyncStream<String>.Continuation) {
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
