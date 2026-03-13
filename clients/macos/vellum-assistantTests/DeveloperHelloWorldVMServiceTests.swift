import XCTest
@testable import VellumAssistantLib

actor ProgressRecorder {
    private(set) var lines: [String] = []

    func append(_ line: String) {
        lines.append(line)
    }

    func snapshot() -> [String] {
        lines
    }
}

actor RuntimeRecorder {
    struct Invocation: Equatable {
        let runtimeRoot: URL
        let kernelURL: URL
    }

    private(set) var invocations: [Invocation] = []

    func append(runtimeRoot: URL, kernelURL: URL) {
        invocations.append(Invocation(runtimeRoot: runtimeRoot, kernelURL: kernelURL))
    }

    func snapshot() -> [Invocation] {
        invocations
    }
}

private struct FixtureError: LocalizedError {
    let message: String

    var errorDescription: String? {
        message
    }
}

final class DeveloperHelloWorldVMServiceTests: XCTestCase {
    private var tempDirectory: URL!

    override func setUp() {
        super.setUp()
        tempDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDirectory)
        super.tearDown()
    }

    func testRunHelloWorldUsesCachedKernelAndLaunchesRuntime() async throws {
        let kernelDirectory = tempDirectory.appendingPathComponent("kata-3.17.0-arm64", isDirectory: true)
        try FileManager.default.createDirectory(at: kernelDirectory, withIntermediateDirectories: true)
        let kernelURL = kernelDirectory.appendingPathComponent("vmlinux.container")
        try "kernel".write(to: kernelURL, atomically: true, encoding: .utf8)

        let runtime = RuntimeRecorder()
        let progress = ProgressRecorder()

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { _ in
                XCTFail("Kernel download should not be triggered when the cached kernel exists.")
                return URL(fileURLWithPath: "/dev/null")
            },
            extractTarArchive: { _, _ in
                XCTFail("Kernel extraction should not be triggered when the cached kernel exists.")
            },
            launchRuntime: { runtimeRoot, installedKernelURL, _ in
                await runtime.append(runtimeRoot: runtimeRoot, kernelURL: installedKernelURL)
                return .init(
                    stdout: "Hello from the Vellum developer VM\n",
                    stderr: "",
                    exitCode: 0
                )
            }
        )

        let result = try await service.runHelloWorld { message in
            await progress.append(message)
        }

        XCTAssertEqual(result.kernelURL, kernelURL)
        let invocations = await runtime.snapshot()
        XCTAssertEqual(invocations, [
            .init(
                runtimeRoot: tempDirectory.appendingPathComponent("apple-containerization", isDirectory: true),
                kernelURL: kernelURL
            )
        ])

        let progressMessages = await progress.snapshot()
        XCTAssertTrue(progressMessages.contains(where: { $0.contains("Using cached Kata kernel") }))
        XCTAssertTrue(progressMessages.contains("Using Apple containerization directly."))
        XCTAssertTrue(progressMessages.contains(where: { $0.contains("VM output:") }))
    }

    func testRunHelloWorldUsesBundledKernelWithoutDownload() async throws {
        let bundledKernelDirectory = tempDirectory.appendingPathComponent("DeveloperVM/kata-3.17.0-arm64", isDirectory: true)
        try FileManager.default.createDirectory(at: bundledKernelDirectory, withIntermediateDirectories: true)
        let bundledKernelURL = bundledKernelDirectory.appendingPathComponent("vmlinux.container")
        try "bundled-kernel".write(to: bundledKernelURL, atomically: true, encoding: .utf8)

        let runtime = RuntimeRecorder()
        let progress = ProgressRecorder()

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { bundledKernelURL },
            downloadKernelArchive: { _ in
                XCTFail("Bundled kernels should not trigger downloads.")
                return URL(fileURLWithPath: "/dev/null")
            },
            extractTarArchive: { _, _ in
                XCTFail("Bundled kernels should not trigger extraction.")
            },
            launchRuntime: { runtimeRoot, installedKernelURL, _ in
                await runtime.append(runtimeRoot: runtimeRoot, kernelURL: installedKernelURL)
                return .init(
                    stdout: "Hello from the Vellum developer VM\n",
                    stderr: "",
                    exitCode: 0
                )
            }
        )

        let result = try await service.runHelloWorld { message in
            await progress.append(message)
        }

        XCTAssertEqual(result.kernelURL, bundledKernelURL)
        let invocations = await runtime.snapshot()
        XCTAssertEqual(invocations, [
            .init(
                runtimeRoot: tempDirectory.appendingPathComponent("apple-containerization", isDirectory: true),
                kernelURL: bundledKernelURL
            )
        ])

        let progressMessages = await progress.snapshot()
        XCTAssertTrue(progressMessages.contains(where: { $0.contains("Using bundled Kata kernel") }))
    }

    func testRunHelloWorldDownloadsKernelAndUsesInstalledKernel() async throws {
        let archiveURL = tempDirectory.appendingPathComponent("kata.tar.xz")
        try Data().write(to: archiveURL)

        let runtime = RuntimeRecorder()
        let progress = ProgressRecorder()

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { requestedURL in
                XCTAssertEqual(requestedURL, DeveloperHelloWorldVMService.kataKernelArchiveURL)
                return archiveURL
            },
            extractTarArchive: { _, destination in
                let extractedKernelURL = destination
                    .appendingPathComponent(DeveloperHelloWorldVMService.kataKernelArchiveMember)
                try FileManager.default.createDirectory(
                    at: extractedKernelURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try "kernel".write(to: extractedKernelURL, atomically: true, encoding: .utf8)
            },
            launchRuntime: { runtimeRoot, installedKernelURL, _ in
                await runtime.append(runtimeRoot: runtimeRoot, kernelURL: installedKernelURL)
                return .init(
                    stdout: "Hello from the Vellum developer VM\n",
                    stderr: "",
                    exitCode: 0
                )
            }
        )

        let result = try await service.runHelloWorld { message in
            await progress.append(message)
        }

        let installedKernelURL = tempDirectory
            .appendingPathComponent("kata-3.17.0-arm64/vmlinux.container")
        XCTAssertEqual(result.kernelURL, installedKernelURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: installedKernelURL.path))
        let invocations = await runtime.snapshot()
        XCTAssertEqual(invocations, [
            .init(
                runtimeRoot: tempDirectory.appendingPathComponent("apple-containerization", isDirectory: true),
                kernelURL: installedKernelURL
            )
        ])

        let progressMessages = await progress.snapshot()
        XCTAssertTrue(progressMessages.contains(where: { $0.contains("Downloading the Kata 3.17.0 ARM64 kernel archive") }))
        XCTAssertTrue(progressMessages.contains(where: { $0.contains("Installed Kata kernel") }))
    }

    func testRunHelloWorldFailsWhenRuntimeThrows() async {
        let kernelDirectory = tempDirectory.appendingPathComponent("kata-3.17.0-arm64", isDirectory: true)
        try? FileManager.default.createDirectory(at: kernelDirectory, withIntermediateDirectories: true)
        let kernelURL = kernelDirectory.appendingPathComponent("vmlinux.container")
        try? "kernel".write(to: kernelURL, atomically: true, encoding: .utf8)

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { _ in
                XCTFail("Kernel download should not run when the cached kernel exists.")
                return URL(fileURLWithPath: "/dev/null")
            },
            extractTarArchive: { _, _ in
                XCTFail("Kernel extraction should not run when the cached kernel exists.")
            },
            launchRuntime: { _, _, _ in
                throw FixtureError(message: "boom")
            }
        )

        do {
            _ = try await service.runHelloWorld { _ in }
            XCTFail("Expected runtime error.")
        } catch let error as DeveloperHelloWorldVMService.ServiceError {
            XCTAssertEqual(error, .runtimeFailed("boom"))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testRunHelloWorldFailsWhenRuntimeExitsNonZero() async {
        let kernelDirectory = tempDirectory.appendingPathComponent("kata-3.17.0-arm64", isDirectory: true)
        try? FileManager.default.createDirectory(at: kernelDirectory, withIntermediateDirectories: true)
        let kernelURL = kernelDirectory.appendingPathComponent("vmlinux.container")
        try? "kernel".write(to: kernelURL, atomically: true, encoding: .utf8)

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { _ in
                XCTFail("Kernel download should not run when the cached kernel exists.")
                return URL(fileURLWithPath: "/dev/null")
            },
            extractTarArchive: { _, _ in
                XCTFail("Kernel extraction should not run when the cached kernel exists.")
            },
            launchRuntime: { _, _, _ in
                .init(stdout: "", stderr: "permission denied", exitCode: 13)
            }
        )

        do {
            _ = try await service.runHelloWorld { _ in }
            XCTFail("Expected non-zero exit error.")
        } catch let error as DeveloperHelloWorldVMService.ServiceError {
            XCTAssertEqual(
                error,
                .runtimeFailed("The VM exited with status 13. permission denied")
            )
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testRunHelloWorldReplacesStaleKernelDestinationCreatedDuringInstall() async throws {
        let archiveURL = tempDirectory.appendingPathComponent("kata.tar.xz")
        try Data().write(to: archiveURL)

        let installedKernelURL = tempDirectory
            .appendingPathComponent("kata-3.17.0-arm64/vmlinux.container")

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { _ in archiveURL },
            extractTarArchive: { _, destination in
                let extractedKernelURL = destination
                    .appendingPathComponent(DeveloperHelloWorldVMService.kataKernelArchiveMember)
                try FileManager.default.createDirectory(
                    at: extractedKernelURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try "fresh-kernel".write(to: extractedKernelURL, atomically: true, encoding: .utf8)

                try FileManager.default.createDirectory(
                    at: installedKernelURL.deletingLastPathComponent(),
                    withIntermediateDirectories: true
                )
                try "stale-kernel".write(to: installedKernelURL, atomically: true, encoding: .utf8)
            },
            launchRuntime: { _, installedKernelURL, _ in
                .init(stdout: installedKernelURL.lastPathComponent, stderr: "", exitCode: 0)
            }
        )

        let result = try await service.runHelloWorld { _ in }

        XCTAssertEqual(result.kernelURL, installedKernelURL)
        let installedContents = try String(contentsOf: installedKernelURL, encoding: .utf8)
        XCTAssertEqual(installedContents, "fresh-kernel")
    }

    func testRunHelloWorldInstallsSymlinkedKernelWithBackingFile() async throws {
        let archiveURL = tempDirectory.appendingPathComponent("kata.tar.xz")
        try Data().write(to: archiveURL)

        let installedKernelURL = tempDirectory
            .appendingPathComponent("kata-3.17.0-arm64/vmlinux.container")

        let service = DeveloperHelloWorldVMService(
            kernelInstallRoot: tempDirectory,
            locateBundledKernel: { nil },
            downloadKernelArchive: { _ in archiveURL },
            extractTarArchive: { _, destination in
                let extractedDirectory = destination
                    .appendingPathComponent("opt/kata/share/kata-containers", isDirectory: true)
                try FileManager.default.createDirectory(
                    at: extractedDirectory,
                    withIntermediateDirectories: true
                )
                let versionedKernel = extractedDirectory.appendingPathComponent("vmlinux-6.12.28-153")
                try "real-kernel".write(to: versionedKernel, atomically: true, encoding: .utf8)
                try FileManager.default.createSymbolicLink(
                    atPath: extractedDirectory.appendingPathComponent("vmlinux.container").path,
                    withDestinationPath: "vmlinux-6.12.28-153"
                )
            },
            launchRuntime: { _, installedKernelURL, _ in
                .init(stdout: installedKernelURL.lastPathComponent, stderr: "", exitCode: 0)
            }
        )

        let result = try await service.runHelloWorld { _ in }

        XCTAssertEqual(result.kernelURL, installedKernelURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: installedKernelURL.path))
        let resolvedKernelURL = installedKernelURL.resolvingSymlinksInPath()
        XCTAssertTrue(FileManager.default.fileExists(atPath: resolvedKernelURL.path))
        let installedContents = try String(contentsOf: resolvedKernelURL, encoding: .utf8)
        XCTAssertEqual(installedContents, "real-kernel")
    }
}
