import Containerization
import ContainerizationError
import ContainerizationOCI
import Foundation
import VellumAssistantShared
import os

private let developerVMLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "DeveloperHelloWorldVM"
)

struct DeveloperHelloWorldVMRunResult: Sendable, Equatable {
    let stdout: String
    let stderr: String
    let kernelURL: URL
}

struct DeveloperHelloWorldVMService: Sendable {
    struct RuntimeRunResult: Sendable, Equatable {
        let stdout: String
        let stderr: String
        let exitCode: Int32
    }

    enum ServiceError: LocalizedError, Equatable {
        case kernelNotFound
        case runtimeFailed(String)

        var errorDescription: String? {
            switch self {
            case .kernelNotFound:
                return "The bundled Kata kernel was not found in the app bundle."
            case .runtimeFailed(let detail):
                return "Failed to launch the hello-world VM. \(detail)"
            }
        }
    }

    typealias ProgressHandler = @Sendable (String) async -> Void
    typealias BundledKernelLocator = @Sendable () -> URL?
    typealias RuntimeLauncher = @Sendable (URL, URL, @escaping ProgressHandler) async throws -> RuntimeRunResult

    static let containerizationRepositoryURL = URL(string: "https://github.com/apple/containerization")!
    static let bundledKernelSubdirectory = "DeveloperVM"
    static let helloWorldImage = "docker.io/library/alpine:latest"
    static let helloWorldMessage = "Hello from the Vellum developer VM"
    static let initImageVersion = "0.30.1"
    static let initImageReference = "ghcr.io/apple/containerization/vminit:\(initImageVersion)"
    static let helloWorldFilesystemSizeInBytes: UInt64 = 64 * 1024 * 1024

    let runtimeRoot: URL
    let locateBundledKernel: BundledKernelLocator
    let launchRuntime: RuntimeLauncher

    init(
        runtimeRoot: URL = Self.defaultRuntimeRoot(),
        locateBundledKernel: @escaping BundledKernelLocator = { Self.defaultBundledKernelURL() },
        launchRuntime: @escaping RuntimeLauncher = { try await Self.defaultLaunchRuntime(runtimeRoot: $0, kernelURL: $1, progress: $2) }
    ) {
        self.runtimeRoot = runtimeRoot
        self.locateBundledKernel = locateBundledKernel
        self.launchRuntime = launchRuntime
    }

    func runHelloWorld(progress: @escaping ProgressHandler) async throws -> DeveloperHelloWorldVMRunResult {
        guard let kernelURL = locateBundledKernel() else {
            throw ServiceError.kernelNotFound
        }

        await progress("Using bundled Kata kernel at \(kernelURL.path)")
        let runtimeResult: RuntimeRunResult
        do {
            runtimeResult = try await launchRuntime(runtimeRoot, kernelURL, progress)
        } catch let error as ServiceError {
            throw error
        } catch {
            developerVMLog.error("Failed to launch hello-world VM: \(error.localizedDescription, privacy: .public)")
            throw ServiceError.runtimeFailed(error.localizedDescription)
        }

        guard runtimeResult.exitCode == 0 else {
            throw ServiceError.runtimeFailed(
                "The VM exited with status \(runtimeResult.exitCode). \(bestAvailableOutput(from: runtimeResult))"
            )
        }

        let trimmedStdout = runtimeResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStdout.isEmpty {
            await progress("VM output:\n\(trimmedStdout)")
        } else {
            await progress("VM finished without stdout output.")
        }

        return DeveloperHelloWorldVMRunResult(
            stdout: runtimeResult.stdout,
            stderr: runtimeResult.stderr,
            kernelURL: kernelURL
        )
    }

    private func bestAvailableOutput(from result: RuntimeRunResult) -> String {
        let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stderr.isEmpty { return stderr }
        let stdout = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !stdout.isEmpty { return stdout }
        return "No stdout or stderr was produced."
    }

    private static func defaultLaunchRuntime(
        runtimeRoot: URL,
        kernelURL: URL,
        progress: @escaping ProgressHandler
    ) async throws -> RuntimeRunResult {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)

        let kernel = Kernel(path: kernelURL, platform: .linuxArm)
        let store = try await DeveloperVMContainerStore(
            root: runtimeRoot,
            kernel: kernel,
            initPath: runtimeRoot.appendingPathComponent("vminit-\(Self.initImageVersion).ext4"),
            rootFilesystemPath: runtimeRoot.appendingPathComponent("hello-world-alpine.ext4")
        )

        let stdoutWriter = BufferedWriter()
        let stderrWriter = BufferedWriter()
        let container = try await store.createContainer(
            id: "vellum-dev-\(UUID().uuidString.lowercased())",
            reference: Self.helloWorldImage,
            filesystemSizeInBytes: Self.helloWorldFilesystemSizeInBytes,
            progress: progress
        ) { config in
            config.process.arguments = ["/bin/sh", "-lc", "echo \(Self.helloWorldMessage)"]
            config.process.workingDirectory = "/"
            if !config.process.environmentVariables.contains(where: { $0.hasPrefix("HOME=") }) {
                config.process.environmentVariables.append("HOME=/")
            }
            config.process.stdout = stdoutWriter
            config.process.stderr = stderrWriter
        }

        await progress("Booting the lightweight VM and starting Alpine...")
        do {
            try await container.create()
            try await container.start()
            let exitStatus = try await container.wait()
            try await container.stop()

            return RuntimeRunResult(
                stdout: stdoutWriter.contents,
                stderr: stderrWriter.contents,
                exitCode: exitStatus.exitCode
            )
        } catch {
            try? await container.stop()
            throw error
        }
    }

    private static func defaultRuntimeRoot() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("developer-vm", isDirectory: true)
    }

    private static func defaultBundledKernelURL() -> URL? {
        let relativePath = bundledKernelSubdirectory + "/vmlinux.container"

        if let resourceURL = Bundle.main.resourceURL?
            .appendingPathComponent(relativePath),
           FileManager.default.fileExists(atPath: resourceURL.path) {
            return resourceURL
        }

        let directBuildURL = Bundle.main.bundleURL.appendingPathComponent(relativePath)
        if FileManager.default.fileExists(atPath: directBuildURL.path) {
            return directBuildURL
        }

        return nil
    }

}

private struct DeveloperVMContainerStore: Sendable {
    private let imageStore: ImageStore
    private let root: URL
    private let kernel: Kernel
    private let initPath: URL
    private let rootFilesystemPath: URL

    init(root: URL, kernel: Kernel, initPath: URL, rootFilesystemPath: URL) async throws {
        self.root = root
        self.kernel = kernel
        self.initPath = initPath
        self.rootFilesystemPath = rootFilesystemPath

        let contentStore = try LocalContentStore(path: root.appendingPathComponent("content", isDirectory: true))
        self.imageStore = try ImageStore(path: root, contentStore: contentStore)
    }

    func createContainer(
        id: String,
        reference: String,
        filesystemSizeInBytes: UInt64,
        progress: @escaping DeveloperHelloWorldVMService.ProgressHandler,
        configure: @escaping (inout LinuxContainer.Configuration) -> Void
    ) async throws -> LinuxContainer {
        let initImage = try await fetchInitImage(progress: progress)
        let initFilesystem = try await createInitFilesystem(from: initImage)
        let image = try await fetchImage(reference: reference, progress: progress)
        let rootFilesystem = try await createRootFilesystem(
            from: image,
            filesystemSizeInBytes: filesystemSizeInBytes
        )

        let manager = VZVirtualMachineManager(
            kernel: kernel,
            initialFilesystem: initFilesystem
        )

        let imageConfig = try await image.config(for: .current).config
        return try LinuxContainer(id, rootfs: rootFilesystem, vmm: manager) { config in
            if let imageConfig {
                config.process = .init(from: imageConfig)
            }
            configure(&config)
        }
    }

    private func fetchInitImage(
        progress: @escaping DeveloperHelloWorldVMService.ProgressHandler
    ) async throws -> InitImage {
        do {
            let image = try await imageStore.get(reference: DeveloperHelloWorldVMService.initImageReference)
            return InitImage(image: image)
        } catch let error as ContainerizationError {
            guard error.code == .notFound else {
                throw error
            }
            await progress("Downloading Apple's vminit guest image...")
            let image = try await imageStore.pull(reference: DeveloperHelloWorldVMService.initImageReference)
            return InitImage(image: image)
        }
    }

    private func fetchImage(
        reference: String,
        progress: @escaping DeveloperHelloWorldVMService.ProgressHandler
    ) async throws -> Containerization.Image {
        do {
            return try await imageStore.get(reference: reference)
        } catch let error as ContainerizationError {
            guard error.code == .notFound else {
                throw error
            }
            await progress("Pulling \(reference)...")
            return try await imageStore.pull(reference: reference)
        }
    }

    private func createInitFilesystem(from initImage: InitImage) async throws -> Containerization.Mount {
        do {
            return try await initImage.initBlock(at: initPath, for: .linuxArm)
        } catch let error as ContainerizationError {
            guard error.code == .exists else {
                throw error
            }
            return .block(
                format: "ext4",
                source: initPath.path,
                destination: "/",
                options: ["ro"]
            )
        }
    }

    private func createRootFilesystem(
        from image: Containerization.Image,
        filesystemSizeInBytes: UInt64
    ) async throws -> Containerization.Mount {
        do {
            let unpacker = EXT4Unpacker(blockSizeInBytes: filesystemSizeInBytes)
            return try await unpacker.unpack(
                image,
                for: .current,
                at: rootFilesystemPath
            )
        } catch let error as ContainerizationError {
            guard error.code == .exists else {
                throw error
            }
            return .block(
                format: "ext4",
                source: rootFilesystemPath.path,
                destination: "/",
                options: []
            )
        }
    }
}

private final class BufferedWriter: Writer, @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func write(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        self.data.append(data)
    }

    func close() throws {}

    var contents: String {
        lock.lock()
        let snapshot = data
        lock.unlock()
        return String(decoding: snapshot, as: UTF8.self)
    }
}
