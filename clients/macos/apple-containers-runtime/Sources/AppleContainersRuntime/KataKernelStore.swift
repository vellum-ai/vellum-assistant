import Containerization
import ContainerizationOCI
import Foundation

// KataKernelStore — manages the kata kernel and init-filesystem images
// required by Apple Containerization's LinuxPod API.
//
// Apple Containerization boots each LinuxPod inside a Virtualization framework
// VM.  The VM needs two pre-pulled OCI images:
//
//   1. The kata kernel image  — a platform-specific Linux kernel binary
//      stored as an OCI artifact (`application/vnd.apple.containerization.kernel`).
//   2. The vminitd init image — a minimal root filesystem that hosts the in-VM
//      agent that manages container lifecycle.
//
// Both images are pulled into the shared `ImageStore` (Apple Containerization's
// local image cache) on the first call to `ensureImagesReady()` and reused on
// subsequent calls, satisfying the "kernel reuse" requirement.
//
// No code in this file shells out to `container`, `docker`, or any other
// external binary.  All I/O goes through Containerization framework APIs.

/// Errors emitted by `KataKernelStore`.
public enum KataKernelStoreError: LocalizedError {
    /// The image pull failed.
    case pullFailed(image: String, underlying: Error)
    /// The kernel could not be extracted from its OCI image.
    case kernelExtractionFailed(underlying: Error)
    /// The init filesystem could not be unpacked from its OCI image.
    case initFilesystemExtractionFailed(underlying: Error)
    /// The required filesystem directory could not be created.
    case directoryCreationFailed(path: String, underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .pullFailed(let image, let err):
            return "Failed to pull kernel image '\(image)': \(err.localizedDescription)"
        case .kernelExtractionFailed(let err):
            return "Failed to extract kernel from OCI image: \(err.localizedDescription)"
        case .initFilesystemExtractionFailed(let err):
            return "Failed to unpack init filesystem: \(err.localizedDescription)"
        case .directoryCreationFailed(let path, let err):
            return "Could not create directory '\(path)': \(err.localizedDescription)"
        }
    }
}

/// Manages the kernel and init-filesystem images required to start a
/// `LinuxPod` VM via Apple Containerization.
///
/// ### Image references
/// Apple Containerization publishes its kernel and init images to GitHub
/// Container Registry (ghcr.io).  The default references follow the pattern:
///
///   - Kernel:  `ghcr.io/apple/containerization/kernel:<version>`
///   - Vminitd: `ghcr.io/apple/containerization/vminitd:<version>`
///
/// ### Caching
/// Images are stored in the Containerization `ImageStore` (Apple's local image
/// cache under `~/Library/Application Support/com.apple.containerization`).
/// A pulled image is not re-downloaded on subsequent calls — `isCached` checks
/// whether the reference already exists in the store.
///
/// ### Usage
/// ```swift
/// let store = KataKernelStore()
/// try await store.ensureImagesReady()
/// let kernel = try await store.kernel()
/// let initMount = try await store.initFilesystem(at: unpackPath)
/// ```
public final class KataKernelStore: @unchecked Sendable {

    // MARK: - Defaults

    /// The GHCR namespace for Apple Containerization images.
    public static let defaultImageNamespace = "ghcr.io/apple/containerization"

    /// The version tag used for kernel and vminitd images.
    /// Update this constant when the containerization dependency version changes.
    public static let defaultImageVersion = "0.12.1"

    // MARK: - Properties

    /// The OCI reference of the kernel image.
    public let kernelImageReference: String

    /// The OCI reference of the vminitd init-filesystem image.
    public let vminitdImageReference: String

    /// The `ImageStore` used to pull and cache images.
    public let imageStore: ImageStore

    private let lock = NSLock()
    private var _imagesReady = false

    // MARK: - Lifecycle

    /// Create a store with custom image references.
    ///
    /// - Parameters:
    ///   - kernelImageReference: OCI reference for the kernel image.
    ///   - vminitdImageReference: OCI reference for the vminitd image.
    ///   - imageStore: The image store to use.  Defaults to
    ///     `ImageStore.default` (the shared system image store).
    public init(
        kernelImageReference: String? = nil,
        vminitdImageReference: String? = nil,
        imageStore: ImageStore? = nil
    ) {
        let ns = Self.defaultImageNamespace
        let ver = Self.defaultImageVersion
        self.kernelImageReference  = kernelImageReference  ?? "\(ns)/kernel:\(ver)"
        self.vminitdImageReference = vminitdImageReference ?? "\(ns)/vminitd:\(ver)"
        self.imageStore = imageStore ?? ImageStore.default
    }

    // MARK: - Public API

    /// Returns `true` when both the kernel and vminitd images are present in
    /// the image store.
    ///
    /// This property checks the `ImageStore` for the cached OCI manifest — it
    /// does **not** perform any network requests.
    public var isCached: Bool {
        lock.lock()
        let ready = _imagesReady
        lock.unlock()
        if ready { return true }
        return false
    }

    /// Ensures the kernel and vminitd OCI images are available in the image
    /// store, pulling them from GHCR if they are not already cached.
    ///
    /// This method is idempotent: calling it multiple times when the images
    /// are already present returns immediately without making network requests.
    public func ensureImagesReady() async throws {
        lock.lock()
        let ready = _imagesReady
        lock.unlock()
        if ready { return }

        try await pullImageIfNeeded(reference: kernelImageReference)
        try await pullImageIfNeeded(reference: vminitdImageReference)

        lock.lock()
        _imagesReady = true
        lock.unlock()
    }

    /// Returns a `Kernel` struct pointing to the cached kernel binary.
    ///
    /// Call `ensureImagesReady()` before this method to guarantee the image
    /// is in the store.
    public func kernel() async throws -> Kernel {
        do {
            let kernelImage = try await imageStore.vellumGetKernelImage(reference: kernelImageReference)
            return try await kernelImage.kernel(for: .linuxArm)
        } catch {
            throw KataKernelStoreError.kernelExtractionFailed(underlying: error)
        }
    }

    /// Unpacks the vminitd init filesystem as an ext4 block device at the
    /// given path and returns a `Mount` suitable for passing to
    /// `VZVirtualMachineManager`.
    ///
    /// - Parameter unpackPath: The directory where the ext4 image file will
    ///   be written.
    public func initFilesystem(at unpackPath: URL) async throws -> Mount {
        do {
            try FileManager.default.createDirectory(
                at: unpackPath,
                withIntermediateDirectories: true
            )
        } catch {
            throw KataKernelStoreError.directoryCreationFailed(
                path: unpackPath.path, underlying: error)
        }

        do {
            let initImage = try await imageStore.getInitImage(reference: vminitdImageReference)
            return try await initImage.initBlock(at: unpackPath, for: .linuxArm)
        } catch {
            throw KataKernelStoreError.initFilesystemExtractionFailed(underlying: error)
        }
    }

    // MARK: - Internal helpers

    /// Invalidates the in-memory `_imagesReady` flag.  For testing only.
    public func invalidateCache() {
        lock.lock()
        _imagesReady = false
        lock.unlock()
    }

    // MARK: - Private helpers

    private func pullImageIfNeeded(reference: String) async throws {
        // Check whether the image is already in the store before pulling.
        do {
            _ = try await imageStore.get(reference: reference)
            return  // already cached
        } catch {}

        do {
            _ = try await imageStore.pull(reference: reference)
        } catch {
            throw KataKernelStoreError.pullFailed(image: reference, underlying: error)
        }
    }
}

// MARK: - ImageStore convenience extension

extension ImageStore {
    /// Retrieves a `KernelImage` from the image store for the given OCI reference,
    /// pulling it from the remote registry if it is not already cached.
    ///
    /// Named with a `vellum` prefix to avoid clashes with methods that may
    /// be added to `ImageStore` in future versions of Apple Containerization.
    func vellumGetKernelImage(reference: String, auth: Authentication? = nil) async throws -> KernelImage {
        do {
            let image = try await self.get(reference: reference)
            return KernelImage(image: image)
        } catch let error as ContainerizationError where error.code == .notFound {
            let image = try await self.pull(reference: reference, auth: auth)
            return KernelImage(image: image)
        }
    }
}
