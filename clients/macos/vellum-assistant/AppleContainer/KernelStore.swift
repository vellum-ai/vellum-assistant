import Containerization
import ContainerizationError
import ContainerizationOCI
import Foundation
import VellumAssistantShared

/// Manages the VM boot infrastructure: the bundled Kata kernel and the
/// vminit guest-init image pulled from the containerization registry.
struct KataKernelStore: Sendable {

    typealias ProgressHandler = @Sendable (String) async -> Void

    private static let initImageVersion = "0.30.1"
    static let initImageReference = "ghcr.io/apple/containerization/vminit:\(initImageVersion)"
    static let bundledKernelSubdirectory = "DeveloperVM"

    /// Root directory for runtime data (image store, init filesystem, etc.).
    let runtimeRoot: URL

    /// Locates the bundled Kata kernel. Injectable for testing.
    let locateKernel: @Sendable () -> URL?

    init(
        runtimeRoot: URL = Self.defaultRuntimeRoot(),
        locateKernel: @escaping @Sendable () -> URL? = { Self.defaultBundledKernelURL() }
    ) {
        self.runtimeRoot = runtimeRoot
        self.locateKernel = locateKernel
    }

    /// Returns the URL of the bundled Kata kernel, or throws if not found.
    func requireKernel() throws -> URL {
        guard let url = locateKernel() else {
            throw KernelStoreError.kernelNotFound
        }
        return url
    }

    /// Creates an `ImageStore` rooted at `runtimeRoot`.
    func makeImageStore() async throws -> ImageStore {
        try FileManager.default.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        let contentStore = try LocalContentStore(
            path: runtimeRoot.appendingPathComponent("content", isDirectory: true)
        )
        return try ImageStore(path: runtimeRoot, contentStore: contentStore)
    }

    /// Prepares the vminit ext4 block device, pulling the image if needed.
    func prepareInitFilesystem(
        store: ImageStore,
        progress: @escaping ProgressHandler
    ) async throws -> Containerization.Mount {
        let initImage: InitImage
        do {
            let image = try await store.get(reference: Self.initImageReference)
            initImage = InitImage(image: image)
        } catch let error as ContainerizationError where error.code == .notFound {
            await progress("Downloading vminit guest image...")
            let image = try await store.pull(reference: Self.initImageReference)
            initImage = InitImage(image: image)
        }

        let initPath = runtimeRoot.appendingPathComponent("vminit-\(Self.initImageVersion).ext4")
        do {
            return try await initImage.initBlock(at: initPath, for: .linuxArm)
        } catch let error as ContainerizationError where error.code == .exists {
            return .block(format: "ext4", source: initPath.path, destination: "/", options: ["ro"])
        }
    }

    enum KernelStoreError: LocalizedError, Equatable {
        case kernelNotFound

        var errorDescription: String? {
            switch self {
            case .kernelNotFound:
                return "The bundled Kata kernel was not found in the app bundle."
            }
        }
    }

    // MARK: - Default Locations

    static func defaultRuntimeRoot() -> URL {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)

        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
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
