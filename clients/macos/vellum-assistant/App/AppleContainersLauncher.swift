import Containerization
import ContainerizationError
import ContainerizationOCI
import Foundation
import os
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "AppleContainersLauncher"
)

/// Manages the lifecycle of an assistant running inside an Apple Container
/// (lightweight Linux VM via the Containerization framework).
///
/// Conforms to `AssistantManagementClient` so `AppDelegate.managementClient(for:)`
/// can dispatch to it for `isAppleContainer` entries.
///
/// Requires macOS 26+ and Apple Silicon (ARM64). Callers should gate on
/// `AppleContainersAvailabilityChecker.check()` before using this launcher.
@MainActor
final class AppleContainersLauncher: AssistantManagementClient {

    // MARK: - Errors

    enum LauncherError: LocalizedError {
        case unavailable(AppleContainersAvailabilityChecker.UnavailableReason)
        case kernelNotFound
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
            case .kernelNotFound:
                return "The bundled Linux kernel was not found in the app bundle."
            case .hatchFailed(let detail):
                return "Failed to hatch Apple Container: \(detail)"
            }
        }
    }

    // MARK: - Configuration

    static let initImageVersion = "0.30.1"
    static let initImageReference = "ghcr.io/apple/containerization/vminit:\(initImageVersion)"
    static let bundledKernelSubdirectory = "DeveloperVM"
    static let defaultFilesystemSizeInBytes: UInt64 = 2 * 1024 * 1024 * 1024

    /// OCI image for the assistant container. Will be replaced with the
    /// production assistant image once the container build pipeline ships.
    static let assistantImageReference = "docker.io/library/ubuntu:24.04"

    // MARK: - Running State

    /// Retains the running container so ARC does not tear it down when hatch() returns.
    private(set) var runningContainer: LinuxContainer?
    /// Retains the VM manager backing the running container.
    private(set) var vmManager: VZVirtualMachineManager?
    /// Name of the currently-running assistant, if any.
    private(set) var runningAssistantName: String?

    // MARK: - Testable Hooks

    /// Locates the bundled Linux kernel. Override in tests.
    nonisolated(unsafe) static var locateBundledKernel: () -> URL? = {
        defaultBundledKernelURL()
    }

    /// Checks availability. Override in tests to bypass OS/hardware gates.
    nonisolated(unsafe) static var checkAvailability: () -> AppleContainersAvailabilityChecker.Availability = {
        AppleContainersAvailabilityChecker.check()
    }

    // MARK: - AssistantManagementClient

    func hatch(name: String?, configValues: [String: String]) async throws {
        let availability = Self.checkAvailability()
        if case .unavailable(let reason) = availability {
            log.error("Apple Containers not available: \(String(describing: reason), privacy: .public)")
            throw LauncherError.unavailable(reason)
        }
        guard case .available = availability else { return }

        guard let kernelURL = Self.locateBundledKernel() else {
            log.error("Bundled Linux kernel not found")
            throw LauncherError.kernelNotFound
        }

        let assistantName = name ?? "apple-container-\(UUID().uuidString.prefix(8).lowercased())"
        let runtimeRoot = Self.runtimeRoot(for: assistantName)

        log.info("Hatching apple-container '\(assistantName, privacy: .public)' at \(runtimeRoot.path, privacy: .public)")

        do {
            try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)

            let kernel = Kernel(path: kernelURL, platform: .linuxArm)
            let contentStore = try LocalContentStore(
                path: runtimeRoot.appendingPathComponent("content", isDirectory: true)
            )
            let imageStore = try ImageStore(path: runtimeRoot, contentStore: contentStore)

            // Fetch or pull init image
            let initImage = try await Self.fetchOrPull(
                reference: Self.initImageReference,
                store: imageStore,
                label: "vminit"
            )
            let initPath = runtimeRoot.appendingPathComponent("vminit-\(Self.initImageVersion).ext4")
            let initFilesystem = try await Self.createInitFilesystem(
                from: InitImage(image: initImage),
                at: initPath
            )

            // Fetch or pull assistant image
            let assistantImage = try await Self.fetchOrPull(
                reference: Self.assistantImageReference,
                store: imageStore,
                label: "assistant"
            )
            let rootFSPath = runtimeRoot.appendingPathComponent("rootfs.ext4")
            let rootFilesystem = try await Self.createRootFilesystem(
                from: assistantImage,
                at: rootFSPath
            )

            let manager = VZVirtualMachineManager(
                kernel: kernel,
                initialFilesystem: initFilesystem
            )

            let containerId = "vellum-\(assistantName)"
            let imageConfig = try await assistantImage.config(for: .current).config
            let container = try LinuxContainer(containerId, rootfs: rootFilesystem, vmm: manager) { config in
                if let imageConfig {
                    config.process = .init(from: imageConfig)
                }
                // Keep the container alive so the assistant processes can run.
                config.process.arguments = ["/bin/sh", "-lc", "sleep infinity"]
                config.process.workingDirectory = "/"
                if !config.process.environmentVariables.contains(where: { $0.hasPrefix("HOME=") }) {
                    config.process.environmentVariables.append("HOME=/root")
                }
            }

            log.info("Starting container '\(containerId, privacy: .public)'...")
            try await container.create()
            try await container.start()

            // Retain the container and VM manager so ARC doesn't tear them down.
            self.runningContainer = container
            self.vmManager = manager
            self.runningAssistantName = assistantName
            log.info("Apple container '\(assistantName, privacy: .public)' is running")

            let hatchedAt = ISO8601DateFormatter().string(from: Date())
            LockfileAssistant.ensureAppleContainerEntry(
                assistantId: assistantName,
                hatchedAt: hatchedAt
            )
            LockfileAssistant.setActiveAssistantId(assistantName)
            log.info("Lockfile entry written for '\(assistantName, privacy: .public)'")
        } catch let error as LauncherError {
            throw error
        } catch {
            log.error("Apple container hatch failed: \(error.localizedDescription, privacy: .public)")
            throw LauncherError.hatchFailed(error.localizedDescription)
        }
    }

    // MARK: - Image Fetching

    private static func fetchOrPull(
        reference: String,
        store: ImageStore,
        label: String
    ) async throws -> Containerization.Image {
        do {
            let image = try await store.get(reference: reference)
            log.info("Using cached \(label, privacy: .public) image")
            return image
        } catch let error as ContainerizationError {
            guard error.code == .notFound else { throw error }
            log.info("Pulling \(label, privacy: .public) image: \(reference, privacy: .public)")
            return try await store.pull(reference: reference)
        }
    }

    // MARK: - Filesystem Creation

    private static func createInitFilesystem(
        from initImage: InitImage,
        at path: URL
    ) async throws -> Containerization.Mount {
        do {
            return try await initImage.initBlock(at: path, for: .linuxArm)
        } catch let error as ContainerizationError {
            guard error.code == .exists else { throw error }
            return .block(
                format: "ext4",
                source: path.path,
                destination: "/",
                options: ["ro"]
            )
        }
    }

    private static func createRootFilesystem(
        from image: Containerization.Image,
        at path: URL
    ) async throws -> Containerization.Mount {
        do {
            let unpacker = EXT4Unpacker(blockSizeInBytes: defaultFilesystemSizeInBytes)
            return try await unpacker.unpack(image, for: .current, at: path)
        } catch let error as ContainerizationError {
            guard error.code == .exists else { throw error }
            return .block(
                format: "ext4",
                source: path.path,
                destination: "/",
                options: []
            )
        }
    }

    // MARK: - Paths

    private static func runtimeRoot(for assistantName: String) -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
            .appendingPathComponent(assistantName, isDirectory: true)
    }

    static func defaultBundledKernelURL() -> URL? {
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
