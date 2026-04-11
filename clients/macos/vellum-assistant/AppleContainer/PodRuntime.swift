import Containerization
import ContainerizationError
import ContainerizationOCI
import ContainerizationOS
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
@available(macOS 26.0, *)
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
        var platformURL: String?
        /// Size of the ext4 rootfs block device per service container.
        /// Size declared in ext4 superblock metadata. Must be >= the unpacked
        /// image content. APFS uses sparse files so this doesn't consume real
        /// disk space beyond what's written.
        var rootfsSizeInBytes: UInt64 = 1024 * 1024 * 1024 // 1 GiB
    }

    private let kernelStore: KataKernelStore
    private let config: Configuration

    private let lock = NSLock()
    private var _pod: LinuxPod?
    private var _network: VmnetNetwork?
    private var _assistantLogStream: AsyncStream<String>?
    private var _gatewayURL: String?

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

        // 2. Create instance directory and pull/unpack service images.
        try FileManager.default.createDirectory(
            at: config.instanceDir, withIntermediateDirectories: true
        )

        let rootfsDir = config.instanceDir.appendingPathComponent(".rootfs", isDirectory: true)
        try FileManager.default.createDirectory(at: rootfsDir, withIntermediateDirectories: true)

        await progress("Pulling and unpacking service images...")

        let results = try await withThrowingTaskGroup(
            of: (VellumServiceName, Containerization.Mount, ContainerizationOCI.ImageConfig?).self
        ) { group in
            for service in VellumServiceName.startOrder {
                guard let ref = config.serviceImageRefs[service] else {
                    throw PodRuntimeError.missingImageRef(service)
                }
                group.addTask {
                    let image = try await self.pullImage(
                        reference: ref, store: imageStore, progress: progress
                    )
                    let imgConfig = try await image.config(for: .current).config
                    let rootfsPath = rootfsDir.appendingPathComponent("\(service.rawValue).ext4")
                    let mount = try await self.createRootFilesystem(
                        from: image, sizeInBytes: self.config.rootfsSizeInBytes, at: rootfsPath
                    )
                    await progress("\(service.rawValue) ready")
                    return (service, mount, imgConfig)
                }
            }

            var rootfs: [VellumServiceName: Containerization.Mount] = [:]
            var configs: [VellumServiceName: ContainerizationOCI.ImageConfig?] = [:]
            for try await (service, mount, imgConfig) in group {
                rootfs[service] = mount
                configs[service] = imgConfig
            }
            return (rootfs, configs)
        }

        let rootfsMounts = results.0
        let imageConfigs = results.1

        // 3. Create host-side shared directories.
        let workspaceDir = config.instanceDir.appendingPathComponent("workspace", isDirectory: true)
        let cesBootstrapDir = config.instanceDir.appendingPathComponent("ces-bootstrap", isDirectory: true)
        let gatewaySecurityDir = config.instanceDir.appendingPathComponent("gateway-security", isDirectory: true)
        let cesSecurityDir = config.instanceDir.appendingPathComponent("ces-security", isDirectory: true)
        for dir in [workspaceDir, cesBootstrapDir, gatewaySecurityDir, cesSecurityDir] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }

        // 4. Assemble the LinuxPod with vmnet networking.
        await progress("Starting containers...")
        let vmm = VZVirtualMachineManager(kernel: kernel, initialFilesystem: initMount)
        let podID = "\(config.instanceName)-pod"

        var network = try VmnetNetwork()
        guard let interface = try network.createInterface(podID) else {
            throw PodRuntimeError.networkSetupFailed
        }
        let podIP = interface.ipv4Address.address.description
        log.info("Pod network: \(podIP, privacy: .public)")

        let pod = try LinuxPod(podID, vmm: vmm) { podConfig in
            podConfig.cpus = self.config.cpus
            podConfig.memoryInBytes = self.config.memoryInBytes
            podConfig.interfaces = [interface]
        }

        // Shared virtiofs mounts.
        let sharedMounts: [Containerization.Mount] = [
            .share(source: workspaceDir.path, destination: VellumMountPaths.workspace),
            .share(source: cesBootstrapDir.path, destination: VellumMountPaths.cesBootstrap),
        ]

        // 5. Register containers.
        let (logStream, logWriter) = Self.makeLogPipe()

        // Helper: initialize process from OCI image config, then overlay our env vars.
        @Sendable func applyProcess(
            _ c: inout LinuxPod.ContainerConfiguration,
            service: VellumServiceName,
            extraEnv: [String: String]
        ) {
            if let imgConfig = imageConfigs[service] ?? nil {
                c.process = LinuxProcessConfiguration(from: imgConfig)
            }
            // Append our env vars on top of whatever the image provides.
            for (key, value) in extraEnv {
                c.process.environmentVariables.append("\(key)=\(value)")
            }
            // Ensure PATH is set.
            if !c.process.environmentVariables.contains(where: { $0.hasPrefix("PATH=") }) {
                c.process.environmentVariables.append("PATH=\(LinuxProcessConfiguration.defaultPath)")
            }
        }

        // Assistant
        let assistantEnv = VellumContainerEnv.assistant(
            instanceName: config.instanceName,
            signingKey: config.signingKey,
            cesServiceToken: config.cesServiceToken,
            platformURL: config.platformURL
        )
        try await pod.addContainer(
            containerID(.assistant), rootfs: rootfsMounts[.assistant]!
        ) { c in
            applyProcess(&c, service: .assistant, extraEnv: assistantEnv)
            c.mounts = sharedMounts + LinuxContainer.defaultMounts()
            c.process.stdout = logWriter
            c.process.stderr = logWriter
        }

        // Gateway
        let gatewayEnv = VellumContainerEnv.gateway(
            signingKey: config.signingKey,
            bootstrapSecret: config.bootstrapSecret,
            cesServiceToken: config.cesServiceToken,
            platformURL: config.platformURL
        )
        try await pod.addContainer(
            containerID(.gateway), rootfs: rootfsMounts[.gateway]!
        ) { c in
            applyProcess(&c, service: .gateway, extraEnv: gatewayEnv)
            c.mounts = sharedMounts + [
                .share(source: gatewaySecurityDir.path, destination: VellumMountPaths.gatewaySecurityDir),
            ] + LinuxContainer.defaultMounts()
        }

        // Credential Executor — workspace mounted read-only to match Docker topology.
        let cesEnv = VellumContainerEnv.credentialExecutor(
            cesServiceToken: config.cesServiceToken
        )
        try await pod.addContainer(
            containerID(.credentialExecutor), rootfs: rootfsMounts[.credentialExecutor]!
        ) { c in
            applyProcess(&c, service: .credentialExecutor, extraEnv: cesEnv)
            c.mounts = [
                .share(source: workspaceDir.path, destination: VellumMountPaths.workspace, options: ["ro"]),
                .share(source: cesBootstrapDir.path, destination: VellumMountPaths.cesBootstrap),
                .share(source: cesSecurityDir.path, destination: VellumMountPaths.cesSecurityDir),
            ] + LinuxContainer.defaultMounts()
        }

        // 6. Create and start.
        log.info("Creating pod VM...")
        try await pod.create()
        log.info("Pod VM created. Starting containers...")
        for service in VellumServiceName.startOrder {
            let cid = containerID(service)
            log.info("Starting container \(cid, privacy: .public)...")
            try await pod.startContainer(cid)
            log.info("Container \(cid, privacy: .public) started")
        }

        let gatewayURL = "http://\(podIP):\(VellumContainerPorts.gatewayHTTP)"
        lock.withLock {
            _pod = pod
            _network = network
            _assistantLogStream = logStream
            _gatewayURL = gatewayURL
        }

        log.info("Pod started for '\(self.config.instanceName, privacy: .public)' at \(gatewayURL, privacy: .public)")
    }

    /// Stops all containers and shuts down the VM.
    func stop() async throws {
        let (pod, network): (LinuxPod?, VmnetNetwork?) = lock.withLock {
            let p = _pod
            let n = _network
            _pod = nil
            _network = nil
            _assistantLogStream = nil
            _gatewayURL = nil
            return (p, n)
        }
        guard let pod else { return }
        log.info("Stopping pod for '\(self.config.instanceName, privacy: .public)'")
        try await pod.stop()
        if var network {
            try? network.releaseInterface("\(config.instanceName)-pod")
        }
    }

    /// The assistant container's log stream for readiness detection.
    var assistantLogStream: AsyncStream<String>? {
        lock.withLock { _assistantLogStream }
    }

    /// The gateway URL reachable from the host.
    var gatewayURL: String? {
        lock.withLock { _gatewayURL }
    }

    // MARK: - Exec

    /// An active exec session inside a running container.
    ///
    /// Owns the host-side PTY and the `LinuxProcess`. The management socket
    /// server (PR 2) reads/writes `hostTerminal` and forwards resize events.
    struct ExecSession: Sendable {
        /// Host-side PTY file handle — read for stdout, write for stdin.
        let hostTerminal: Terminal
        /// The spawned process inside the container.
        let process: LinuxProcess

        /// Resize the container PTY to match the client's terminal dimensions.
        func resize(width: UInt16, height: UInt16) async throws {
            try await process.resize(to: Terminal.Size(width: width, height: height))
        }

        /// Wait for the process to exit and clean up.
        @discardableResult
        func wait() async throws -> ExitStatus {
            defer { try? hostTerminal.close() }
            let status = try await process.wait()
            try await process.delete()
            return status
        }
    }

    /// Spawn an interactive process in a running container with a real PTY.
    ///
    /// - Parameters:
    ///   - service: Which container to exec into (defaults to `.assistant`).
    ///   - command: The command and arguments to run (defaults to `["/bin/sh"]`).
    ///   - initialSize: Initial terminal dimensions for the PTY.
    /// - Returns: An `ExecSession` whose `hostTerminal` can be relayed over
    ///   the management socket.
    func exec(
        service: VellumServiceName = .assistant,
        command: [String] = ["/bin/sh"],
        initialSize: Terminal.Size = Terminal.Size(width: 120, height: 40)
    ) async throws -> ExecSession {
        let pod: LinuxPod = try lock.withLock {
            guard let pod = _pod else {
                throw PodRuntimeError.podNotRunning
            }
            return pod
        }

        let cid = containerID(service)
        let processID = "exec-\(UUID().uuidString.prefix(8))"

        let (parentTerminal, childTerminal) = try Terminal.create(initialSize: initialSize)

        do {
            let process = try await pod.execInContainer(cid, processID: processID) { config in
                config.arguments = command
                config.setTerminalIO(terminal: childTerminal)
            }

            try await process.start()
            log.info("Exec session \(processID, privacy: .public) started in \(cid, privacy: .public)")

            return ExecSession(hostTerminal: parentTerminal, process: process)
        } catch {
            try? parentTerminal.close()
            try? childTerminal.close()
            throw error
        }
    }

    // MARK: - Errors

    enum PodRuntimeError: LocalizedError {
        case missingImageRef(VellumServiceName)
        case networkSetupFailed
        case podNotRunning

        var errorDescription: String? {
            switch self {
            case .missingImageRef(let service):
                return "No image reference provided for \(service.rawValue)."
            case .networkSetupFailed:
                return "Failed to create vmnet network interface for pod."
            case .podNotRunning:
                return "Cannot exec: pod is not running."
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
            // Validate the cached rootfs is actually ext4 before reusing it.
            if Self.isValidEXT4(at: path) {
                return .block(format: "ext4", source: path.path, destination: "/", options: [])
            }
            // Corrupt from a previous interrupted unpack — delete and retry.
            log.warning("Corrupt rootfs at \(path.path, privacy: .public) — deleting and re-unpacking")
            try? FileManager.default.removeItem(at: path)
            let unpacker = EXT4Unpacker(blockSizeInBytes: sizeInBytes)
            return try await unpacker.unpack(image, for: .current, at: path)
        }
    }

    /// Quick check: ext4 superblock magic number 0xEF53 at offset 0x438.
    private static func isValidEXT4(at path: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: path) else { return false }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: 0x438)
            guard let data = try handle.read(upToCount: 2), data.count == 2 else { return false }
            // ext4 magic is 0xEF53 in little-endian
            return data[0] == 0x53 && data[1] == 0xEF
        } catch {
            return false
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
