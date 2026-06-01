import XCTest
@testable import VellumAssistantLib

@available(macOS 26.0, *)
final class LocalImageBuilderTests: XCTestCase {

    // MARK: - Repo Root Detection

    func testFindRepoRootFindsDirectoryWithDockerfile() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localimagebuilder-test-\(UUID().uuidString)")
        let assistantDir = tmpDir.appendingPathComponent("assistant")
        try FileManager.default.createDirectory(at: assistantDir, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: assistantDir.appendingPathComponent("Dockerfile").path,
            contents: Data("FROM debian".utf8)
        )
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        // Starting from a subdirectory should walk up and find the root.
        let nested = tmpDir.appendingPathComponent("some/deep/path")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)

        let found = LocalImageBuilder.findRepoRoot(startingFrom: nested)
        XCTAssertEqual(found?.standardizedFileURL, tmpDir.standardizedFileURL)
    }

    func testFindRepoRootReturnsNilWhenNoDockerfile() {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localimagebuilder-noroot-\(UUID().uuidString)")
        let found = LocalImageBuilder.findRepoRoot(startingFrom: tmpDir)
        XCTAssertNil(found)
    }

    func testFindRepoRootReturnsDirectParentIfDockerfilePresent() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localimagebuilder-direct-\(UUID().uuidString)")
        let assistantDir = tmpDir.appendingPathComponent("assistant")
        try FileManager.default.createDirectory(at: assistantDir, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: assistantDir.appendingPathComponent("Dockerfile").path,
            contents: Data("FROM debian".utf8)
        )
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let found = LocalImageBuilder.findRepoRoot(startingFrom: tmpDir)
        XCTAssertEqual(found?.standardizedFileURL, tmpDir.standardizedFileURL)
    }

    // MARK: - Full Source Tree Detection

    func testHasFullSourceTreeReturnsTrueWhenPackageJsonExists() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localimagebuilder-source-\(UUID().uuidString)")
        let assistantDir = tmpDir.appendingPathComponent("assistant")
        try FileManager.default.createDirectory(at: assistantDir, withIntermediateDirectories: true)
        FileManager.default.createFile(
            atPath: assistantDir.appendingPathComponent("package.json").path,
            contents: Data("{}".utf8)
        )
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        XCTAssertTrue(LocalImageBuilder.hasFullSourceTree(at: tmpDir))
    }

    func testHasFullSourceTreeReturnsFalseWhenMissing() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("localimagebuilder-nosource-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        XCTAssertFalse(LocalImageBuilder.hasFullSourceTree(at: tmpDir))
    }

    // MARK: - Build Configs

    func testBuildConfigsMatchesCLILayout() {
        let root = URL(fileURLWithPath: "/repo")
        let refs = VellumImageReference.defaults(version: "latest")
        let configs = LocalImageBuilder.buildConfigs(repoRoot: root, imageRefs: refs)

        XCTAssertEqual(configs.count, 3)

        let byService = Dictionary(uniqueKeysWithValues: configs.map { ($0.service, $0) })

        // Assistant: context=repoRoot, dockerfile=repoRoot/assistant/Dockerfile
        let assistant = byService[.assistant]!
        XCTAssertEqual(assistant.context, root)
        XCTAssertEqual(assistant.dockerfile.lastPathComponent, "Dockerfile")
        XCTAssertTrue(assistant.dockerfile.path.contains("assistant"))

        // Gateway: context=repoRoot/gateway, dockerfile=repoRoot/gateway/Dockerfile
        let gateway = byService[.gateway]!
        XCTAssertEqual(gateway.context, root.appendingPathComponent("gateway"))
        XCTAssertEqual(gateway.dockerfile.lastPathComponent, "Dockerfile")
        XCTAssertTrue(gateway.dockerfile.path.contains("gateway"))

        // CES: context=repoRoot, dockerfile=repoRoot/credential-executor/Dockerfile
        let ces = byService[.credentialExecutor]!
        XCTAssertEqual(ces.context, root)
        XCTAssertTrue(ces.dockerfile.path.contains("credential-executor"))
    }

    func testBuildConfigTagsMatchImageRefs() {
        let root = URL(fileURLWithPath: "/repo")
        let refs = VellumImageReference.defaults(version: "1.2.3")
        let configs = LocalImageBuilder.buildConfigs(repoRoot: root, imageRefs: refs)

        for config in configs {
            let expectedRef = refs[config.service]!.fullReference
            XCTAssertEqual(config.tag, expectedRef, "Tag mismatch for \(config.service)")
        }
    }

    func testBuildConfigSkipsMissingRefs() {
        let root = URL(fileURLWithPath: "/repo")
        // Only provide one ref — the others should be skipped.
        let refs: [VellumServiceName: VellumImageReference] = [
            .assistant: VellumImageReference(registry: "docker.io", repository: "test/assistant", tag: "v1"),
        ]
        let configs = LocalImageBuilder.buildConfigs(repoRoot: root, imageRefs: refs)
        XCTAssertEqual(configs.count, 1)
        XCTAssertEqual(configs.first?.service, .assistant)
    }

    // MARK: - Docker Availability

    func testDockerAvailabilityUsesShellHook() async {
        var called = false
        let saved = LocalImageBuilder.runShellCommand
        defer { LocalImageBuilder.runShellCommand = saved }

        LocalImageBuilder.runShellCommand = { executable, arguments, _ in
            if arguments.contains("info") {
                called = true
                return "Docker version 24.0"
            }
            return ""
        }

        let available = await LocalImageBuilder.isDockerAvailable()
        XCTAssertTrue(available)
        XCTAssertTrue(called)
    }

    func testDockerUnavailableWhenCommandFails() async {
        let saved = LocalImageBuilder.runShellCommand
        defer { LocalImageBuilder.runShellCommand = saved }

        LocalImageBuilder.runShellCommand = { _, _, _ in
            throw LocalImageBuilder.ShellCommandError(
                executable: "docker", exitCode: 1, output: "not found"
            )
        }

        let available = await LocalImageBuilder.isDockerAvailable()
        XCTAssertFalse(available)
    }

    // MARK: - Error Descriptions

    func testBuildErrorDescriptions() {
        let errors: [LocalImageBuilder.BuildError] = [
            .dockerUnavailable,
            .repoRootNotFound,
            .noFullSourceTree(URL(fileURLWithPath: "/some/path")),
            .buildFailed(service: .gateway, output: "build error"),
            .loadFailed(service: .assistant, detail: "load error"),
        ]
        for error in errors {
            XCTAssertNotNil(error.errorDescription, "Missing description for \(error)")
            XCTAssertFalse(error.errorDescription!.isEmpty)
        }
    }

    func testShellCommandErrorDescription() {
        let error = LocalImageBuilder.ShellCommandError(
            executable: "/usr/bin/docker", exitCode: 127, output: "not found"
        )
        XCTAssertTrue(error.errorDescription!.contains("127"))
        XCTAssertTrue(error.errorDescription!.contains("not found"))
    }
}
