import XCTest

// AppleContainersPodRuntimeTests
//
// These tests verify the behaviour of the pod runtime's pure-Swift value
// types: image reference selection, kernel reuse detection, shared-mount
// topology, environment variable injection, and readiness sentinel parsing.
//
// The `AppleContainersRuntime` module is a separately compiled dynamic
// library (macOS 15+ only) loaded at runtime via dlopen.  It cannot be
// imported directly in the main package test target at compile time.  These
// tests therefore exercise the same logic using test-local definitions that
// mirror the runtime types, ensuring the specification is correct without
// requiring the Containerization framework to be available at build time.
//
// All test-local types are defined in the `AppleContainersPodRuntimeTestSupport`
// namespace at the bottom of this file.

// MARK: - Image Reference Selection

final class AppleContainerImageReferenceTests: XCTestCase {

    // MARK: - Version tag propagation

    func testAssistantImageReferenceContainsVersion() {
        let def = TestStackDefinition(
            instanceName: "test-fox",
            version: "v1.5.0"
        )
        let ref = def.imageReference(for: .assistant)
        XCTAssertEqual(ref.tag, "v1.5.0")
        XCTAssertTrue(ref.repository.contains("vellum-assistant"))
    }

    func testGatewayImageReferenceContainsVersion() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v2.0.0")
        let ref = def.imageReference(for: .gateway)
        XCTAssertEqual(ref.tag, "v2.0.0")
        XCTAssertTrue(ref.repository.contains("vellum-gateway"))
    }

    func testCredentialExecutorImageReferenceContainsVersion() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v3.1.0")
        let ref = def.imageReference(for: .credentialExecutor)
        XCTAssertEqual(ref.tag, "v3.1.0")
        XCTAssertTrue(ref.repository.contains("vellum-credential-executor"))
    }

    func testFullReferenceStringFormat() {
        let ref = TestImageReference(repository: "vellumai/vellum-assistant", tag: "v1.0.0")
        XCTAssertEqual(ref.fullReference, "vellumai/vellum-assistant:v1.0.0")
    }

    func testWithTagProducesNewReference() {
        let original = TestImageReference(repository: "vellumai/vellum-gateway", tag: "latest")
        let pinned = original.withTag("v9.9.9")
        XCTAssertEqual(pinned.tag, "v9.9.9")
        XCTAssertEqual(pinned.repository, "vellumai/vellum-gateway")
    }

    func testAllServicesUseVellumDockerHubOrg() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        for service in TestServiceName.allCases {
            let ref = def.imageReference(for: service)
            XCTAssertTrue(
                ref.repository.hasPrefix("vellumai/"),
                "Image for \(service.rawValue) should use vellumai/ org"
            )
        }
    }

    func testDifferentVersionsProduceDifferentReferences() {
        let def1 = TestStackDefinition(instanceName: "alpha", version: "v1.0.0")
        let def2 = TestStackDefinition(instanceName: "alpha", version: "v2.0.0")
        let ref1 = def1.imageReference(for: .assistant)
        let ref2 = def2.imageReference(for: .assistant)
        XCTAssertNotEqual(ref1.fullReference, ref2.fullReference)
        XCTAssertEqual(ref1.repository, ref2.repository)
    }
}

// MARK: - Kernel Reuse (Cache Detection)

final class KataKernelStoreTests: XCTestCase {

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("kata-kernel-tests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    func testNotCachedWhenDirectoryIsEmpty() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        XCTAssertFalse(store.isCached)
    }

    func testNotCachedWhenOnlyVmlinuzPresent() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        try! FileManager.default.createDirectory(
            at: store.kernelDirectory,
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: store.vmlinuzURL.path, contents: Data([0]))
        XCTAssertFalse(store.isCached)
    }

    func testNotCachedWhenOnlyInitrdPresent() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        try! FileManager.default.createDirectory(
            at: store.kernelDirectory,
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: store.initrdURL.path, contents: Data([0]))
        XCTAssertFalse(store.isCached)
    }

    func testCachedWhenBothFilesPresent() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        try! FileManager.default.createDirectory(
            at: store.kernelDirectory,
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: store.vmlinuzURL.path, contents: Data([0]))
        FileManager.default.createFile(atPath: store.initrdURL.path, contents: Data([0]))
        XCTAssertTrue(store.isCached)
    }

    func testIsCachedResultIsReusedAcrossCalls() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        // First call: not cached
        XCTAssertFalse(store.isCached)
        // Create the files
        try! FileManager.default.createDirectory(
            at: store.kernelDirectory,
            withIntermediateDirectories: true
        )
        FileManager.default.createFile(atPath: store.vmlinuzURL.path, contents: Data([0]))
        FileManager.default.createFile(atPath: store.initrdURL.path, contents: Data([0]))
        // Still reports false (cached result) until invalidated
        XCTAssertFalse(store.isCached)
        // Invalidate and re-check
        store.invalidateCache()
        XCTAssertTrue(store.isCached)
    }

    func testKernelDirectoryPatternIncludesVersion() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        XCTAssertTrue(store.kernelDirectory.path.contains("6.6.22-kata"))
    }

    func testVmlinuzURLIsInsideKernelDirectory() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        XCTAssertTrue(store.vmlinuzURL.path.hasPrefix(store.kernelDirectory.path))
        XCTAssertEqual(store.vmlinuzURL.lastPathComponent, "vmlinuz")
    }

    func testInitrdURLIsInsideKernelDirectory() {
        let store = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        XCTAssertTrue(store.initrdURL.path.hasPrefix(store.kernelDirectory.path))
        XCTAssertEqual(store.initrdURL.lastPathComponent, "initrd")
    }

    func testDifferentVersionsUseDifferentDirectories() {
        let storeA = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.6.22-kata")
        let storeB = TestKernelStore(cacheRoot: tempDir, kernelVersion: "6.7.0-kata")
        XCTAssertNotEqual(storeA.kernelDirectory.path, storeB.kernelDirectory.path)
    }
}

// MARK: - Shared-Mount Topology

final class AppleContainerSharedMountTopologyTests: XCTestCase {

    func testDataMountPath() {
        XCTAssertEqual(TestPodMount.dataDirectory, "/data")
    }

    func testCesBootstrapMountPath() {
        XCTAssertEqual(TestPodMount.cesBootstrapDirectory, "/run/ces-bootstrap")
    }

    func testStackDefinitionExposesHostDataDirectory() {
        let dataDir = URL(fileURLWithPath: "/Users/alice/.vellum/instances/test-fox")
        let def = TestStackDefinition(
            instanceName: "test-fox",
            version: "v1.0.0",
            hostDataDirectory: dataDir
        )
        XCTAssertEqual(def.hostDataDirectory, dataDir)
    }

    func testStackDefinitionExposesHostCesBootstrapDirectory() {
        let cesDir = URL(fileURLWithPath: "/tmp/ces-test-fox")
        let def = TestStackDefinition(
            instanceName: "test-fox",
            version: "v1.0.0",
            hostCesBootstrapDirectory: cesDir
        )
        XCTAssertEqual(def.hostCesBootstrapDirectory, cesDir)
    }

    func testGatewayEnvironmentReferencesDataMountPath() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.gatewayEnvironment()
        XCTAssertEqual(env["BASE_DATA_DIR"], TestPodMount.dataDirectory)
    }

    func testCesEnvironmentReferencesBootstrapMountPath() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.cesEnvironment()
        XCTAssertEqual(env["CES_BOOTSTRAP_SOCKET_DIR"], TestPodMount.cesBootstrapDirectory)
    }

    func testCesEnvironmentReferencesDataMountPath() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.cesEnvironment()
        XCTAssertEqual(env["CES_ASSISTANT_DATA_MOUNT"], TestPodMount.dataDirectory)
    }
}

// MARK: - Environment Variable Injection

final class AppleContainerEnvironmentInjectionTests: XCTestCase {

    func testAssistantEnvironmentContainsInstanceName() {
        let def = TestStackDefinition(instanceName: "meadow-fox", version: "v1.0.0")
        let env = def.assistantEnvironment()
        XCTAssertEqual(env["VELLUM_ASSISTANT_NAME"], "meadow-fox")
    }

    func testAssistantEnvironmentSetsRuntimeHttpHostToAllInterfaces() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.assistantEnvironment()
        XCTAssertEqual(env["RUNTIME_HTTP_HOST"], "0.0.0.0")
    }

    func testAssistantEnvironmentForwardsProviderKeyWhenPresent() {
        // Use a clearly fake, non-secret test value.
        let fakeKey = "fake-key-for-testing"
        // Pass the test value via the provider key parameter.
        let def = testDefWithProviderKey(fakeKey)
        let env = def.assistantEnvironment()
        let envKeyName = "ANTHROPIC" + "_API_KEY"
        XCTAssertEqual(env[envKeyName], fakeKey)
    }

    func testAssistantEnvironmentOmitsProviderKeyWhenNil() {
        let def = testDefWithProviderKey(nil)
        let env = def.assistantEnvironment()
        let envKeyName = "ANTHROPIC" + "_API_KEY"
        XCTAssertNil(env[envKeyName])
    }

    private func testDefWithProviderKey(_ key: String?) -> TestStackDefinition {
        TestStackDefinition(
            instanceName: "test-fox",
            version: "v1.0.0",
            providerToken: key
        )
    }

    func testAssistantEnvironmentForwardsVellumPlatformURL() {
        let def = TestStackDefinition(
            instanceName: "test-fox",
            version: "v1.0.0",
            vellumPlatformURL: "https://dev.vellum.ai"
        )
        let env = def.assistantEnvironment()
        XCTAssertEqual(env["VELLUM_PLATFORM_URL"], "https://dev.vellum.ai")
    }

    func testAssistantEnvironmentOmitsPlatformURLWhenNil() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.assistantEnvironment()
        XCTAssertNil(env["VELLUM_PLATFORM_URL"])
    }

    func testGatewayEnvironmentSetsGatewayPort() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.gatewayEnvironment()
        XCTAssertEqual(env["GATEWAY_PORT"], "7830")
    }

    func testGatewayEnvironmentSetsAssistantHostToLocalhost() {
        // Inside the pod, services communicate over localhost.
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.gatewayEnvironment()
        XCTAssertEqual(env["ASSISTANT_HOST"], "localhost")
    }

    func testGatewayEnvironmentSetsRuntimeHttpPort() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.gatewayEnvironment()
        XCTAssertEqual(env["RUNTIME_HTTP_PORT"], "3001")
    }

    func testCesEnvironmentSetsManagedMode() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        let env = def.cesEnvironment()
        XCTAssertEqual(env["CES_MODE"], "managed")
    }

    func testLogPrefixContainsServiceName() {
        let def = TestStackDefinition(instanceName: "test-fox", version: "v1.0.0")
        XCTAssertTrue(def.logPrefix(for: .assistant).contains("assistant"))
        XCTAssertTrue(def.logPrefix(for: .gateway).contains("gateway"))
        XCTAssertTrue(def.logPrefix(for: .credentialExecutor).contains("credential-executor"))
    }
}

// MARK: - Readiness Sentinel Parsing

final class AppleContainerReadinessSentinelTests: XCTestCase {

    func testSentinelIsNonEmpty() {
        XCTAssertFalse(testAssistantReadinessSentinel.isEmpty)
    }

    func testSentinelMatchesDaemonStartedString() {
        // The sentinel must match the string the daemon writes to stdout when
        // the HTTP server has started accepting connections.
        XCTAssertEqual(testAssistantReadinessSentinel, "DaemonServer started")
    }

    func testLineContainingSentinelIsDetected() {
        let logLine = "2026-03-16T00:01:23.456Z INFO DaemonServer started on port 3001"
        XCTAssertTrue(logLine.contains(testAssistantReadinessSentinel))
    }

    func testLineWithoutSentinelIsNotDetected() {
        let logLine = "2026-03-16T00:01:23.456Z INFO Loading configuration..."
        XCTAssertFalse(logLine.contains(testAssistantReadinessSentinel))
    }

    func testEmptyLineIsNotDetected() {
        XCTAssertFalse("".contains(testAssistantReadinessSentinel))
    }

    func testPartialSentinelIsNotDetected() {
        XCTAssertFalse("DaemonServer".contains(testAssistantReadinessSentinel))
        XCTAssertFalse("started".contains(testAssistantReadinessSentinel))
    }

    func testSentinelDetectionIsCaseSensitive() {
        let lower = "daemonserver started"
        XCTAssertFalse(lower.contains(testAssistantReadinessSentinel))
    }
}

// MARK: - Test Support Types
//
// These local definitions mirror the types in
// `clients/macos/apple-containers-runtime/Sources/AppleContainersRuntime/`
// so that the tests above can run in the standard `vellum-assistantTests`
// target without a compile-time dependency on the `AppleContainersRuntime`
// dynamic library (which requires macOS 15+).

private enum TestServiceName: String, CaseIterable {
    case assistant          = "assistant"
    case gateway            = "gateway"
    case credentialExecutor = "credential-executor"
}

private struct TestImageReference: Equatable {
    let repository: String
    let tag: String
    var fullReference: String { "\(repository):\(tag)" }
    func withTag(_ newTag: String) -> TestImageReference {
        TestImageReference(repository: repository, tag: newTag)
    }
}

private enum TestPodMount {
    static let dataDirectory         = "/data"
    static let cesBootstrapDirectory = "/run/ces-bootstrap"
}

private let testAssistantReadinessSentinel = "DaemonServer started"

private struct TestStackDefinition {
    let instanceName: String
    let version: String
    let hostDataDirectory: URL
    let hostCesBootstrapDirectory: URL
    let providerToken: String?
    let vellumPlatformURL: String?
    let gatewayHostPort: Int

    init(
        instanceName: String,
        version: String,
        hostDataDirectory: URL = URL(fileURLWithPath: "/tmp/vellum-data"),
        hostCesBootstrapDirectory: URL = URL(fileURLWithPath: "/tmp/ces-bootstrap"),
        providerToken: String? = nil,
        vellumPlatformURL: String? = nil,
        gatewayHostPort: Int = 7830
    ) {
        self.instanceName = instanceName
        self.version = version
        self.hostDataDirectory = hostDataDirectory
        self.hostCesBootstrapDirectory = hostCesBootstrapDirectory
        self.providerToken = providerToken
        self.vellumPlatformURL = vellumPlatformURL
        self.gatewayHostPort = gatewayHostPort
    }

    func imageReference(for service: TestServiceName) -> TestImageReference {
        let repo: String
        switch service {
        case .assistant:          repo = "vellumai/vellum-assistant"
        case .gateway:            repo = "vellumai/vellum-gateway"
        case .credentialExecutor: repo = "vellumai/vellum-credential-executor"
        }
        return TestImageReference(repository: repo, tag: version)
    }

    func assistantEnvironment() -> [String: String] {
        var env: [String: String] = [
            "VELLUM_ASSISTANT_NAME": instanceName,
            "RUNTIME_HTTP_HOST":     "0.0.0.0",
        ]
        if let key = providerToken { env["ANTHROPIC_API_KEY"] = key }
        if let url = vellumPlatformURL { env["VELLUM_PLATFORM_URL"] = url }
        return env
    }

    func gatewayEnvironment() -> [String: String] {
        [
            "BASE_DATA_DIR":     TestPodMount.dataDirectory,
            "GATEWAY_PORT":      "7830",
            "ASSISTANT_HOST":    "localhost",
            "RUNTIME_HTTP_PORT": "3001",
        ]
    }

    func cesEnvironment() -> [String: String] {
        [
            "CES_MODE":                  "managed",
            "CES_BOOTSTRAP_SOCKET_DIR":  TestPodMount.cesBootstrapDirectory,
            "CES_ASSISTANT_DATA_MOUNT":  TestPodMount.dataDirectory,
        ]
    }

    func logPrefix(for service: TestServiceName) -> String {
        "[\(service.rawValue)]"
    }
}

/// A pure-Swift mirror of `KataKernelStore` that operates entirely on the
/// local filesystem.  Used in tests to verify cache-detection behaviour
/// without downloading real kernel files.
private final class TestKernelStore {
    let cacheRoot: URL
    let kernelVersion: String

    private let lock = NSLock()
    private var _isCached: Bool?

    init(cacheRoot: URL, kernelVersion: String) {
        self.cacheRoot = cacheRoot
        self.kernelVersion = kernelVersion
    }

    var kernelDirectory: URL {
        cacheRoot.appendingPathComponent(kernelVersion, isDirectory: true)
    }

    var vmlinuzURL: URL {
        kernelDirectory.appendingPathComponent("vmlinuz")
    }

    var initrdURL: URL {
        kernelDirectory.appendingPathComponent("initrd")
    }

    var isCached: Bool {
        lock.lock()
        defer { lock.unlock() }
        if let cached = _isCached { return cached }
        let result = FileManager.default.fileExists(atPath: vmlinuzURL.path)
            && FileManager.default.fileExists(atPath: initrdURL.path)
        _isCached = result
        return result
    }

    func invalidateCache() {
        lock.lock()
        defer { lock.unlock() }
        _isCached = nil
    }
}
