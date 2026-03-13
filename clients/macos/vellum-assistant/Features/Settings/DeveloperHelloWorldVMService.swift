import Containerization
import ContainerizationError
import ContainerizationOCI
import Foundation
import os

private let developerVMLog = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
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
        case kernelArchiveInvalid(String)
        case runtimeFailed(String)

        var errorDescription: String? {
            switch self {
            case .kernelArchiveInvalid(let detail):
                return "The downloaded Kata kernel archive did not contain a usable kernel. \(detail)"
            case .runtimeFailed(let detail):
                return "Failed to launch the hello-world VM. \(detail)"
            }
        }
    }

    typealias ProgressHandler = @Sendable (String) async -> Void
    typealias BundledKernelLocator = @Sendable () -> URL?
    typealias ArchiveDownloader = @Sendable (URL) async throws -> URL
    typealias TarExtractor = @Sendable (URL, URL) async throws -> Void
    typealias RuntimeLauncher = @Sendable (URL, URL, @escaping ProgressHandler) async throws -> RuntimeRunResult

    static let containerizationRepositoryURL = URL(string: "https://github.com/apple/containerization")!
    static let kataKernelArchiveURL = URL(
        string: "https://github.com/kata-containers/kata-containers/releases/download/3.17.0/kata-static-3.17.0-arm64.tar.xz"
    )!
    static let kataKernelArchiveMember = "opt/kata/share/kata-containers/vmlinux.container"
    static let bundledKernelSubdirectory = "DeveloperVM/kata-3.17.0-arm64"
    static let helloWorldImage = "docker.io/library/alpine:latest"
    static let helloWorldMessage = "Hello from the Vellum developer VM"
    static let initImageReference = "ghcr.io/apple/containerization/vminit:0.1.1"
    static let helloWorldFilesystemSizeInBytes: UInt64 = 512 * 1024 * 1024

    let kernelInstallRoot: URL
    let locateBundledKernel: BundledKernelLocator
    let downloadKernelArchive: ArchiveDownloader
    let extractTarArchive: TarExtractor
    let launchRuntime: RuntimeLauncher

    init(
        kernelInstallRoot: URL = Self.defaultKernelInstallRoot(),
        locateBundledKernel: @escaping BundledKernelLocator = { Self.defaultBundledKernelURL() },
        downloadKernelArchive: @escaping ArchiveDownloader = { try await Self.defaultDownloadKernelArchive(from: $0) },
        extractTarArchive: @escaping TarExtractor = { try await Self.defaultExtractTarArchive(archiveURL: $0, destinationURL: $1) },
        launchRuntime: @escaping RuntimeLauncher = { try await Self.defaultLaunchRuntime(runtimeRoot: $0, kernelURL: $1, progress: $2) }
    ) {
        self.kernelInstallRoot = kernelInstallRoot
        self.locateBundledKernel = locateBundledKernel
        self.downloadKernelArchive = downloadKernelArchive
        self.extractTarArchive = extractTarArchive
        self.launchRuntime = launchRuntime
    }

    func runHelloWorld(progress: @escaping ProgressHandler) async throws -> DeveloperHelloWorldVMRunResult {
        let kernelURL = try await ensureKernel(progress: progress)
        let runtimeRoot = kernelInstallRoot.appendingPathComponent("apple-containerization", isDirectory: true)

        await progress("Using Apple containerization directly.")
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

    private func ensureKernel(progress: @escaping ProgressHandler) async throws -> URL {
        if let bundledKernelURL = locateBundledKernel(),
           isUsableInstalledKernel(at: bundledKernelURL) {
            await progress("Using bundled Kata kernel from the app at \(bundledKernelURL.path)")
            return bundledKernelURL
        }

        let installDirectory = kernelInstallRoot.appendingPathComponent("kata-3.17.0-arm64", isDirectory: true)
        let installedKernelURL = kernelInstallRoot.appendingPathComponent("kata-3.17.0-arm64/vmlinux.container")
        if isUsableInstalledKernel(at: installedKernelURL) {
            await progress("Using cached Kata kernel at \(installedKernelURL.path)")
            return installedKernelURL
        }

        try Task.checkCancellation()
        await progress("Downloading the Kata 3.17.0 ARM64 kernel archive...")
        let downloadedArchiveURL = try await downloadKernelArchive(Self.kataKernelArchiveURL)

        let fileManager = FileManager.default
        let stagingDirectory = kernelInstallRoot.appendingPathComponent("staging-\(UUID().uuidString)", isDirectory: true)

        do {
            try fileManager.createDirectory(at: stagingDirectory, withIntermediateDirectories: true)
            defer {
                try? fileManager.removeItem(at: stagingDirectory)
                if downloadedArchiveURL.isFileURL,
                   downloadedArchiveURL.path.hasPrefix(fileManager.temporaryDirectory.path) {
                    try? fileManager.removeItem(at: downloadedArchiveURL)
                }
            }

            try Task.checkCancellation()
            await progress("Extracting \(downloadedArchiveURL.lastPathComponent)...")
            try await extractTarArchive(downloadedArchiveURL, stagingDirectory)

            guard let extractedKernelURL = findKernel(in: stagingDirectory) else {
                throw ServiceError.kernelArchiveInvalid("Expected archive member: \(Self.kataKernelArchiveMember)")
            }

            try installKernel(
                from: extractedKernelURL.deletingLastPathComponent(),
                installDirectory: installDirectory,
                installedKernelURL: installedKernelURL,
                using: fileManager
            )

            guard isUsableInstalledKernel(at: installedKernelURL) else {
                throw ServiceError.kernelArchiveInvalid("Installed kernel path is missing or broken after extraction.")
            }

            await progress("Installed Kata kernel to \(installedKernelURL.path)")
            return installedKernelURL
        } catch {
            developerVMLog.error("Failed to install Kata kernel: \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    private func isUsableInstalledKernel(at url: URL) -> Bool {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return false
        }

        let resolvedURL = url.resolvingSymlinksInPath()
        guard let resourceValues = try? resolvedURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              resourceValues.isRegularFile == true,
              let fileSize = resourceValues.fileSize,
              fileSize > 0 else {
            return false
        }
        return true
    }

    private func installKernel(
        from extractedKernelDirectory: URL,
        installDirectory: URL,
        installedKernelURL: URL,
        using fileManager: FileManager
    ) throws {
        let temporaryInstallDirectory = kernelInstallRoot.appendingPathComponent(
            "kata-3.17.0-arm64.installing-\(UUID().uuidString)",
            isDirectory: true
        )

        defer {
            try? fileManager.removeItem(at: temporaryInstallDirectory)
        }

        if fileManager.fileExists(atPath: temporaryInstallDirectory.path) {
            try fileManager.removeItem(at: temporaryInstallDirectory)
        }
        try fileManager.createDirectory(at: temporaryInstallDirectory, withIntermediateDirectories: true)

        let extractedItems = try fileManager.contentsOfDirectory(
            at: extractedKernelDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        for item in extractedItems {
            try fileManager.copyItem(
                at: item,
                to: temporaryInstallDirectory.appendingPathComponent(item.lastPathComponent)
            )
        }

        if fileManager.fileExists(atPath: installDirectory.path) {
            try? fileManager.removeItem(at: installedKernelURL)
            try? fileManager.removeItem(at: installDirectory)
        }

        do {
            try fileManager.moveItem(at: temporaryInstallDirectory, to: installDirectory)
        } catch {
            if fileManager.fileExists(atPath: installDirectory.path) {
                try? fileManager.removeItem(at: installDirectory)
                try fileManager.moveItem(at: temporaryInstallDirectory, to: installDirectory)
            } else {
                throw error
            }
        }
    }

    private func findKernel(in root: URL) -> URL? {
        let exactMatch = root.appendingPathComponent(Self.kataKernelArchiveMember)
        if FileManager.default.fileExists(atPath: exactMatch.path) {
            return exactMatch
        }

        let enumerator = FileManager.default.enumerator(
            at: root,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        while let next = enumerator?.nextObject() as? URL {
            if next.lastPathComponent == "vmlinux.container" {
                return next
            }
        }
        return nil
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
            initPath: runtimeRoot.appendingPathComponent("vminit.ext4"),
            rootFilesystemPath: runtimeRoot.appendingPathComponent("hello-world-alpine.ext4")
        )

        let container = try await store.createContainer(
            id: "vellum-dev-\(UUID().uuidString.lowercased())",
            reference: Self.helloWorldImage,
            filesystemSizeInBytes: Self.helloWorldFilesystemSizeInBytes,
            progress: progress
        )

        let stdoutWriter = BufferedWriter()
        let stderrWriter = BufferedWriter()
        container.arguments = ["/bin/sh", "-lc", "echo \(Self.helloWorldMessage)"]
        container.workingDirectory = "/"
        if !container.environment.contains(where: { $0.hasPrefix("HOME=") }) {
            var environment = container.environment
            environment.append("HOME=/")
            container.environment = environment
        }
        container.stdout = stdoutWriter
        container.stderr = stderrWriter

        await progress("Booting the lightweight VM and starting Alpine...")
        do {
            try await container.create()
            try await container.start()
            let exitCode = try await container.wait()
            try await container.stop()

            return RuntimeRunResult(
                stdout: stdoutWriter.contents,
                stderr: stderrWriter.contents,
                exitCode: exitCode
            )
        } catch {
            try? await container.stop()
            throw error
        }
    }

    private static func defaultKernelInstallRoot() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
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

    private static func defaultDownloadKernelArchive(from url: URL) async throws -> URL {
        var request = URLRequest(url: url)
        request.timeoutInterval = 300
        let (temporaryURL, response) = try await URLSession.shared.download(for: request)

        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw ServiceError.kernelArchiveInvalid("Download returned HTTP \(httpResponse.statusCode)")
        }

        let destinationURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("kata-kernel-\(UUID().uuidString).tar.xz")
        try? FileManager.default.removeItem(at: destinationURL)
        try FileManager.default.moveItem(at: temporaryURL, to: destinationURL)
        return destinationURL
    }

    private static func defaultExtractTarArchive(archiveURL: URL, destinationURL: URL) async throws {
        let archive = archiveURL
        let destination = destinationURL

        let result = try await Task.detached(priority: .userInitiated) { () -> RuntimeRunResult in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = ["-xJf", archive.path, "-C", destination.path]

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            try process.run()
            process.waitUntilExit()

            let stdout = String(
                data: stdoutPipe.fileHandleForReading.availableData,
                encoding: .utf8
            ) ?? ""
            let stderr = String(
                data: stderrPipe.fileHandleForReading.availableData,
                encoding: .utf8
            ) ?? ""
            return RuntimeRunResult(stdout: stdout, stderr: stderr, exitCode: process.terminationStatus)
        }.value

        guard result.exitCode == 0 else {
            let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                : result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw ServiceError.kernelArchiveInvalid(detail.isEmpty ? "tar exited with status \(result.exitCode)." : detail)
        }
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
        progress: @escaping DeveloperHelloWorldVMService.ProgressHandler
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
            initialFilesystem: initFilesystem,
            bootlog: root.appendingPathComponent("hello-world-boot.log").path
        )

        let container = LinuxContainer(id, rootfs: rootFilesystem, vmm: manager)
        if let imageConfig = try await image.config(for: ContainerizationOCI.Platform.current).config {
            container.setProcessConfig(from: imageConfig)
        }
        return container
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
            return try await image.unpack(
                for: ContainerizationOCI.Platform.current,
                at: rootFilesystemPath,
                blockSizeInBytes: filesystemSizeInBytes
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

    var contents: String {
        lock.lock()
        let snapshot = data
        lock.unlock()
        return String(decoding: snapshot, as: UTF8.self)
    }
}
