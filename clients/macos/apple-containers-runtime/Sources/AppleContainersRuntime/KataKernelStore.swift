import Containerization
import ContainerizationArchive
import Foundation

// KataKernelStore — manages the Linux kernel binary and init-filesystem image
// required by Apple Containerization's LinuxPod API.
//
// Current Apple Containerization releases use:
//
//   1. A Linux kernel binary fetched from the Kata Containers release artifacts.
//   2. A `vminit` OCI image pulled from GHCR and unpacked into an initial
//      filesystem mount for the VM guest agent.
//
// We cache the kernel file on disk and the init image in the shared
// Containerization `ImageStore` so subsequent hatches can reuse both.

/// Errors emitted by `KataKernelStore`.
public enum KataKernelStoreError: LocalizedError {
    /// The kernel archive download failed.
    case kernelDownloadFailed(url: String, underlying: Error)
    /// The downloaded kernel archive did not contain the expected kernel file.
    case kernelArchiveMissing(entryPath: String)
    /// The init image pull failed.
    case initImagePullFailed(reference: String, underlying: Error)
    /// The kernel binary could not be prepared on disk.
    case kernelPreparationFailed(path: String, underlying: Error)
    /// The init filesystem could not be unpacked from its OCI image.
    case initFilesystemExtractionFailed(underlying: Error)
    /// The required filesystem directory could not be created.
    case directoryCreationFailed(path: String, underlying: Error)

    public var errorDescription: String? {
        switch self {
        case .kernelDownloadFailed(let url, let err):
            return "Failed to download kernel from '\(url)': \(err.localizedDescription)"
        case .kernelArchiveMissing(let entryPath):
            return "Downloaded kernel archive did not contain '\(entryPath)'."
        case .initImagePullFailed(let reference, let err):
            return "Failed to pull init image '\(reference)': \(err.localizedDescription)"
        case .kernelPreparationFailed(let path, let err):
            return "Failed to prepare kernel at '\(path)': \(err.localizedDescription)"
        case .initFilesystemExtractionFailed(let err):
            return "Failed to unpack init filesystem: \(err.localizedDescription)"
        case .directoryCreationFailed(let path, let err):
            return "Could not create directory '\(path)': \(err.localizedDescription)"
        }
    }
}

/// Manages the kernel binary and init-filesystem image required to start a
/// `LinuxPod` VM via Apple Containerization.
///
/// ### Artifacts
/// - Kernel: downloaded from the Kata Containers release tarball and cached on disk
/// - Initfs: `ghcr.io/apple/containerization/vminit:<version>`
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

    /// The Containerization dependency version this runtime is built against.
    public static let defaultImageVersion = AppleContainersRuntime.containerizationVersion

    /// The Kata Containers release used by the upstream Containerization package's
    /// `fetch-default-kernel` helper.
    public static let defaultKataReleaseVersion = "3.17.0"

    /// The downloadable tarball containing the default Kata kernel artifact.
    public static let defaultKernelArchiveURL = URL(
        string: "https://github.com/kata-containers/kata-containers/releases/download/\(defaultKataReleaseVersion)/kata-static-\(defaultKataReleaseVersion)-arm64.tar.xz"
    )!

    /// The kernel path inside the downloaded Kata release tarball.
    public static let defaultKernelArchiveEntryPath = "opt/kata/share/kata-containers/vmlinux.container"

    // MARK: - Properties

    /// The OCI reference of the `vminit` init-filesystem image.
    public let vminitImageReference: String

    /// The URL of the downloadable Kata kernel tarball.
    public let kernelArchiveURL: URL

    /// The path inside the Kata tarball that contains the VM kernel binary.
    public let kernelArchiveEntryPath: String

    /// Root directory for the cached kernel files.
    public let cacheRoot: URL

    /// The `ImageStore` used to pull and cache init images.
    public let imageStore: ImageStore

    private let lock = NSLock()
    private var _imagesReady = false

    // MARK: - Lifecycle

    public init(
        vminitImageReference: String? = nil,
        kernelArchiveURL: URL? = nil,
        kernelArchiveEntryPath: String? = nil,
        cacheRoot: URL? = nil,
        imageStore: ImageStore? = nil
    ) {
        let ns = Self.defaultImageNamespace
        let ver = Self.defaultImageVersion
        self.vminitImageReference = vminitImageReference ?? "\(ns)/vminit:\(ver)"
        self.kernelArchiveURL = kernelArchiveURL ?? Self.defaultKernelArchiveURL
        self.kernelArchiveEntryPath = kernelArchiveEntryPath ?? Self.defaultKernelArchiveEntryPath
        self.cacheRoot = cacheRoot ?? Self.defaultCacheRoot()
        self.imageStore = imageStore ?? ImageStore.default
    }

    // MARK: - Public API

    /// Returns `true` when the kernel binary and init image have been prepared
    /// during the current process lifetime.
    public var isCached: Bool {
        lock.withLock { _imagesReady }
    }

    /// Ensures the kernel binary is cached on disk and the init image is present
    /// in the image store.
    ///
    /// This method is idempotent: repeated calls return immediately after the
    /// first successful preparation.
    public func ensureImagesReady() async throws {
        let ready = lock.withLock { _imagesReady }
        if ready { return }

        try await ensureKernelReady()
        try await pullInitImageIfNeeded(reference: vminitImageReference)

        lock.withLock { _imagesReady = true }
    }

    /// Returns a `Kernel` struct pointing to the cached kernel binary.
    public func kernel() async throws -> Kernel {
        try await ensureKernelReady()
        return Kernel(path: kernelURL, platform: .linuxArm)
    }

    /// Unpacks the `vminit` init filesystem as an ext4 block device at the
    /// given path and returns a `Mount` suitable for passing to
    /// `VZVirtualMachineManager`.
    ///
    /// - Parameter unpackPath: The directory where the ext4 image file will
    ///   be written.
    public func initFilesystem(at unpackPath: URL) async throws -> Containerization.Mount {
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
            let initImage = try await imageStore.getInitImage(reference: vminitImageReference)
            return try await initImage.initBlock(at: unpackPath, for: .linuxArm)
        } catch {
            throw KataKernelStoreError.initFilesystemExtractionFailed(underlying: error)
        }
    }

    // MARK: - Internal helpers

    /// Invalidates the in-memory `_imagesReady` flag.  For testing only.
    public func invalidateCache() {
        lock.withLock { _imagesReady = false }
    }

    // MARK: - Private helpers

    private static func defaultCacheRoot() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent("com.vellum.vellum-assistant", isDirectory: true)
            .appendingPathComponent("apple-containers", isDirectory: true)
            .appendingPathComponent("kernels", isDirectory: true)
    }

    private var kernelDirectory: URL {
        cacheRoot.appendingPathComponent(Self.defaultKataReleaseVersion, isDirectory: true)
    }

    private var kernelArchiveCacheURL: URL {
        kernelDirectory.appendingPathComponent(kernelArchiveURL.lastPathComponent, isDirectory: false)
    }

    private var kernelURL: URL {
        kernelDirectory.appendingPathComponent("vmlinux", isDirectory: false)
    }

    private func ensureKernelReady() async throws {
        if FileManager.default.fileExists(atPath: kernelURL.path) {
            return
        }

        do {
            try FileManager.default.createDirectory(
                at: kernelDirectory,
                withIntermediateDirectories: true
            )
        } catch {
            throw KataKernelStoreError.directoryCreationFailed(
                path: kernelDirectory.path, underlying: error)
        }

        let archiveURL: URL
        if FileManager.default.fileExists(atPath: kernelArchiveCacheURL.path) {
            archiveURL = kernelArchiveCacheURL
        } else {
            archiveURL = try await downloadKernelArchive()
        }

        try extractKernelBinary(from: archiveURL, to: kernelURL)
    }

    private func downloadKernelArchive() async throws -> URL {
        do {
            let (downloadedURL, response) = try await URLSession.shared.download(from: kernelArchiveURL)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw URLError(.badServerResponse)
            }

            if FileManager.default.fileExists(atPath: kernelArchiveCacheURL.path) {
                try FileManager.default.removeItem(at: kernelArchiveCacheURL)
            }
            try FileManager.default.moveItem(at: downloadedURL, to: kernelArchiveCacheURL)
            return kernelArchiveCacheURL
        } catch {
            throw KataKernelStoreError.kernelDownloadFailed(
                url: kernelArchiveURL.absoluteString,
                underlying: error
            )
        }
    }

    private func extractKernelBinary(from archiveURL: URL, to destinationURL: URL) throws {
        let tempURL = destinationURL
            .deletingLastPathComponent()
            .appendingPathComponent("vmlinux-\(UUID().uuidString).tmp", isDirectory: false)

        do {
            let reader = try ArchiveReader(file: archiveURL)
            var iterator = reader.makeStreamingIterator()

            while let (entry, stream) = iterator.next() {
                guard matchesKernelArchiveEntry(entry.path) else { continue }

                FileManager.default.createFile(atPath: tempURL.path, contents: nil)
                let handle = try FileHandle(forWritingTo: tempURL)
                defer { try? handle.close() }

                var buffer = [UInt8](repeating: 0, count: 64 * 1024)
                while true {
                    let bytesRead = buffer.withUnsafeMutableBufferPointer { pointer in
                        guard let baseAddress = pointer.baseAddress else { return -1 }
                        return stream.read(baseAddress, maxLength: pointer.count)
                    }

                    if bytesRead == 0 {
                        break
                    }
                    if bytesRead < 0 {
                        throw KataKernelStoreError.kernelPreparationFailed(
                            path: destinationURL.path,
                            underlying: CocoaError(.fileReadUnknown)
                        )
                    }

                    handle.write(Data(buffer.prefix(bytesRead)))
                }

                if FileManager.default.fileExists(atPath: destinationURL.path) {
                    try FileManager.default.removeItem(at: destinationURL)
                }
                try FileManager.default.moveItem(at: tempURL, to: destinationURL)
                return
            }

            throw KataKernelStoreError.kernelArchiveMissing(entryPath: kernelArchiveEntryPath)
        } catch let error as KataKernelStoreError {
            try? FileManager.default.removeItem(at: tempURL)
            throw error
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw KataKernelStoreError.kernelPreparationFailed(
                path: destinationURL.path,
                underlying: error
            )
        }
    }

    private func pullInitImageIfNeeded(reference: String) async throws {
        do {
            _ = try await imageStore.get(reference: reference)
            return
        } catch {}

        do {
            _ = try await imageStore.pull(reference: reference)
        } catch {
            throw KataKernelStoreError.initImagePullFailed(
                reference: reference,
                underlying: error
            )
        }
    }

    private func matchesKernelArchiveEntry(_ entryPath: String?) -> Bool {
        guard let entryPath else { return false }
        return normalizeArchivePath(entryPath) == normalizeArchivePath(kernelArchiveEntryPath)
    }

    private func normalizeArchivePath(_ path: String) -> String {
        var normalized = path
        while normalized.hasPrefix("./") {
            normalized.removeFirst(2)
        }
        return normalized
    }
}
