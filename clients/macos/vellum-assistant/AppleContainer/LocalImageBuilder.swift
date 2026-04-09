import Containerization
import ContainerizationOCI
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "LocalImageBuilder"
)

/// Builds Vellum service images from local source code using Docker and loads
/// them into the Containerization framework's `ImageStore`.
///
/// This replaces the default "pull from Docker Hub" path during development,
/// so engineers iterate against the code on disk rather than whatever was last
/// published to the registry.
///
/// The build flow mirrors the CLI's `buildAllImages` in `docker.ts`:
///   1. Locate the repo root (walks up from the app bundle).
///   2. `docker buildx build --platform linux/arm64 --output type=oci` for each
///      service Dockerfile.
///   3. Extract the OCI tar and `ImageStore.load(from:)` to import.
///   4. Tag the imported image to match the reference `PodRuntime` expects.
@available(macOS 26.0, *)
enum LocalImageBuilder {

    // MARK: - Types

    struct ServiceBuildConfig {
        let service: VellumServiceName
        let context: URL
        let dockerfile: URL
        let tag: String
    }

    enum BuildError: LocalizedError {
        case dockerUnavailable
        case repoRootNotFound
        case noFullSourceTree(URL)
        case buildFailed(service: VellumServiceName, output: String)
        case loadFailed(service: VellumServiceName, detail: String)

        var errorDescription: String? {
            switch self {
            case .dockerUnavailable:
                return "Docker CLI is not available. Install Docker to build images locally."
            case .repoRootNotFound:
                return "Could not locate the vellum-assistant repository root."
            case .noFullSourceTree(let root):
                return "Dockerfiles found at \(root.path) but no full source tree (missing assistant/package.json)."
            case .buildFailed(let service, let output):
                return "Docker build failed for \(service.rawValue): \(output)"
            case .loadFailed(let service, let detail):
                return "Failed to load built image for \(service.rawValue): \(detail)"
            }
        }
    }

    // MARK: - Testable Hooks

    /// Runs a shell command. Override in tests to avoid real Docker calls.
    nonisolated(unsafe) static var runShellCommand: (
        _ executable: String, _ arguments: [String], _ workingDirectory: URL?
    ) async throws -> String = { executable, arguments, workingDirectory in
        try await defaultRunShellCommand(executable, arguments, workingDirectory)
    }

    // MARK: - Repo Detection

    /// Walks up from `startPath` looking for a directory that contains
    /// `assistant/Dockerfile`, matching the CLI's `findRepoRoot()` logic.
    static func findRepoRoot(startingFrom startPath: URL? = nil) -> URL? {
        let start = startPath ?? Bundle.main.bundleURL
        var dir = start.standardizedFileURL
        while true {
            let marker = dir.appendingPathComponent("assistant").appendingPathComponent("Dockerfile")
            if FileManager.default.fileExists(atPath: marker.path) {
                return dir
            }
            let parent = dir.deletingLastPathComponent().standardizedFileURL
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    /// Returns `true` when the repo root has the full source tree needed to
    /// build images (not just bundled Dockerfiles without source).
    static func hasFullSourceTree(at root: URL) -> Bool {
        let marker = root.appendingPathComponent("assistant").appendingPathComponent("package.json")
        return FileManager.default.fileExists(atPath: marker.path)
    }

    /// Returns `true` when the `docker` CLI is on PATH and responsive.
    static func isDockerAvailable() async -> Bool {
        do {
            _ = try await runShellCommand("/usr/bin/env", ["docker", "info"], nil)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Build Configs

    /// Returns the build configuration for each service, mirroring the CLI's
    /// `serviceImageConfigs()` in `docker.ts`.
    static func buildConfigs(
        repoRoot: URL,
        imageRefs: [VellumServiceName: VellumImageReference]
    ) -> [ServiceBuildConfig] {
        VellumServiceName.allCases.compactMap { service in
            guard let ref = imageRefs[service] else { return nil }
            switch service {
            case .assistant:
                return ServiceBuildConfig(
                    service: service,
                    context: repoRoot,
                    dockerfile: repoRoot.appendingPathComponent("assistant/Dockerfile"),
                    tag: ref.fullReference
                )
            case .gateway:
                return ServiceBuildConfig(
                    service: service,
                    context: repoRoot.appendingPathComponent("gateway"),
                    dockerfile: repoRoot.appendingPathComponent("gateway/Dockerfile"),
                    tag: ref.fullReference
                )
            case .credentialExecutor:
                return ServiceBuildConfig(
                    service: service,
                    context: repoRoot,
                    dockerfile: repoRoot.appendingPathComponent("credential-executor/Dockerfile"),
                    tag: ref.fullReference
                )
            }
        }
    }

    // MARK: - Build + Load

    /// Builds all service images from local source and loads them into
    /// `store` so that `PodRuntime.pullImage()` finds them in cache.
    ///
    /// - Parameters:
    ///   - repoRoot: Repository root containing `assistant/`, `gateway/`, `credential-executor/` Dockerfiles.
    ///   - imageRefs: The image references that `PodRuntime` will look up. Built images are tagged to match.
    ///   - store: The `ImageStore` shared with `PodRuntime`.
    ///   - progress: Progress callback for UI updates.
    static func buildAndLoadImages(
        repoRoot: URL,
        imageRefs: [VellumServiceName: VellumImageReference],
        store: ImageStore,
        progress: @escaping @Sendable (String) async -> Void
    ) async throws {
        let configs = buildConfigs(repoRoot: repoRoot, imageRefs: imageRefs)

        await progress("Building \(configs.count) service images from source...")
        log.info("Building images from \(repoRoot.path, privacy: .public)")

        for config in configs {
            try await buildAndLoadSingleImage(config: config, store: store, progress: progress)
        }

        await progress("All service images built and loaded")
    }

    // MARK: - Private

    private static func buildAndLoadSingleImage(
        config: ServiceBuildConfig,
        store: ImageStore,
        progress: @escaping @Sendable (String) async -> Void
    ) async throws {
        let uniqueID = ProcessInfo.processInfo.globallyUniqueString
        let tmpTar = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-oci-\(config.service.rawValue)-\(uniqueID).tar")
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vellum-oci-\(config.service.rawValue)-\(uniqueID)")

        defer {
            try? FileManager.default.removeItem(at: tmpTar)
            try? FileManager.default.removeItem(at: tmpDir)
        }

        // 1. Build with Docker and export as OCI tar.
        await progress("Building \(config.service.rawValue) from source...")
        log.info("docker buildx build \(config.service.rawValue, privacy: .public) → \(tmpTar.path, privacy: .public)")

        do {
            _ = try await runShellCommand("/usr/bin/env", [
                "docker", "buildx", "build",
                "--platform", "linux/arm64",
                "-t", config.tag,
                "-f", config.dockerfile.path,
                "--output", "type=oci,dest=\(tmpTar.path)",
                config.context.path,
            ], nil)
        } catch let error as ShellCommandError {
            throw BuildError.buildFailed(service: config.service, output: error.output)
        }

        // 2. Extract OCI tar to a directory.
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        _ = try await runShellCommand("/usr/bin/tar", [
            "xf", tmpTar.path, "-C", tmpDir.path,
        ], nil)

        // 3. Load OCI layout into ImageStore.
        let imported: [Containerization.Image]
        do {
            imported = try await store.load(from: tmpDir)
        } catch {
            throw BuildError.loadFailed(
                service: config.service,
                detail: error.localizedDescription
            )
        }

        // 4. Tag to match the reference PodRuntime expects.
        if let first = imported.first, first.reference != config.tag {
            _ = try await store.tag(existing: first.reference, new: config.tag)
            log.info("Tagged \(first.reference, privacy: .public) → \(config.tag, privacy: .public)")
        }

        await progress("\(config.service.rawValue) built and loaded")
        log.info("Loaded \(config.service.rawValue, privacy: .public) as \(config.tag, privacy: .public)")
    }

    // MARK: - Shell Execution

    struct ShellCommandError: LocalizedError {
        let executable: String
        let exitCode: Int32
        let output: String

        var errorDescription: String? {
            "\(executable) exited with code \(exitCode): \(output)"
        }
    }

    private static func defaultRunShellCommand(
        _ executable: String,
        _ arguments: [String],
        _ workingDirectory: URL?
    ) async throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let workingDirectory {
            process.currentDirectoryURL = workingDirectory
        }

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        // Drain the pipe on a detached task so the buffer never fills up.
        // Reading must happen concurrently with the process — if we wait
        // until the terminationHandler, Docker build output (which easily
        // exceeds the ~64 KB pipe buffer) would block the child process
        // on write, preventing termination → deadlock.
        let readTask = Task.detached { () -> Data in
            pipe.fileHandleForReading.readDataToEndOfFile()
        }

        return try await withCheckedThrowingContinuation { continuation in
            // Install the termination handler *before* run() so that a
            // fast-exiting command (e.g. a failing `docker info`) cannot
            // complete before the handler is registered, which would leave
            // the continuation unresumed.
            process.terminationHandler = { proc in
                Task {
                    let data = await readTask.value
                    let output = String(data: data, encoding: .utf8) ?? ""

                    if proc.terminationStatus == 0 {
                        continuation.resume(returning: output)
                    } else {
                        continuation.resume(throwing: ShellCommandError(
                            executable: executable,
                            exitCode: proc.terminationStatus,
                            output: output
                        ))
                    }
                }
            }

            do {
                try process.run()
            } catch {
                // Close the write end so readTask's readDataToEndOfFile() sees EOF
                // and the detached task completes instead of blocking forever.
                try? pipe.fileHandleForWriting.close()
                continuation.resume(throwing: error)
            }
        }
    }
}
