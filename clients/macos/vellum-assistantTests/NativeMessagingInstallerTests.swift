import Foundation
import XCTest
@testable import VellumAssistantLib

/// Tests for `NativeMessagingInstaller` — the macOS install-time
/// helper that writes the Chrome native messaging host manifest
/// (`com.vellum.daemon.json`) into Chrome's well-known per-user
/// `NativeMessagingHosts/` directory.
///
/// These tests use an injected mock `homeDirectory` so the installer
/// writes under a fresh `temporaryDirectory` rather than the real
/// tester's `~/Library/Application Support/Google/Chrome/`. The
/// production public entry points (`installChromeManifest(...)`,
/// `uninstallChromeManifest()`) use `FileManager.default`; the tests
/// exercise the internal testable overloads that accept both the
/// home directory and the file manager explicitly.
final class NativeMessagingInstallerTests: XCTestCase {
    private let placeholderExtensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private var placeholderAllowedOrigin: String {
        "chrome-extension://\(placeholderExtensionId)/"
    }

    private var tempDir: URL!
    private var mockHome: URL!
    private var helperBinaryUrl: URL!

    override func setUp() {
        super.setUp()

        // A fresh scratch root per test, isolated to the test bundle
        // so parallel test runs can't collide.
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("NativeMessagingInstallerTests-\(UUID().uuidString)", isDirectory: true)
        try! FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)

        // Simulate ~/ under tempDir so the installer computes
        // ~/Library/Application Support/Google/Chrome/NativeMessagingHosts
        // relative to a controlled root.
        mockHome = tempDir.appendingPathComponent("home", isDirectory: true)
        try! FileManager.default.createDirectory(at: mockHome, withIntermediateDirectories: true)

        // Stand in for the bundled `vellum-chrome-native-host` binary.
        // The installer only verifies existence via
        // `fileExists(atPath:)`, so a placeholder file is sufficient.
        helperBinaryUrl = tempDir.appendingPathComponent("vellum-chrome-native-host")
        FileManager.default.createFile(
            atPath: helperBinaryUrl.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: NSNumber(value: 0o755)]
        )
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - install

    func testInstallWritesManifestWithExpectedStructure() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: manifestUrl.path),
            "manifest should exist at expected path"
        )

        let data = try Data(contentsOf: manifestUrl)
        let parsed = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(parsed["name"] as? String, "com.vellum.daemon")
        XCTAssertEqual(parsed["description"] as? String, "Vellum assistant native messaging host")
        XCTAssertEqual(parsed["type"] as? String, "stdio")
        XCTAssertEqual(
            parsed["path"] as? String,
            NativeMessagingInstaller.launcherScriptPath(under: mockHome).path
        )

        let origins = try XCTUnwrap(parsed["allowed_origins"] as? [String])
        XCTAssertEqual(origins, [placeholderAllowedOrigin])
    }

    func testInstallWritesLauncherScriptThatExecsHelper() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            vellumEnvironment: "local",
            homeDirectory: mockHome,
            fileManager: .default
        )

        let launcherUrl = NativeMessagingInstaller.launcherScriptPath(under: mockHome)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: launcherUrl.path),
            "launcher script should be written alongside the manifest"
        )

        let contents = try String(contentsOf: launcherUrl, encoding: .utf8)
        XCTAssertTrue(contents.contains("export VELLUM_ENVIRONMENT='local'"))
        XCTAssertTrue(contents.contains("exec '\(helperBinaryUrl.path)' \"$@\""))
    }

    func testInstallSetsManifestPermissionsTo0o644() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")

        let attrs = try FileManager.default.attributesOfItem(atPath: manifestUrl.path)
        let perms = try XCTUnwrap(attrs[.posixPermissions] as? NSNumber)
        XCTAssertEqual(perms.intValue, 0o644)
    }

    func testInstallSetsLauncherPermissionsTo0o755() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        let launcherUrl = NativeMessagingInstaller.launcherScriptPath(under: mockHome)
        let attrs = try FileManager.default.attributesOfItem(atPath: launcherUrl.path)
        let perms = try XCTUnwrap(attrs[.posixPermissions] as? NSNumber)
        XCTAssertEqual(perms.intValue, 0o755)
    }

    func testInstallCreatesIntermediateNativeMessagingHostsDirectory() throws {
        // Sanity: the mock home starts without a Chrome subtree.
        let expectedDir = NativeMessagingInstaller.manifestDirectory(under: mockHome)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: expectedDir.path),
            "precondition: NativeMessagingHosts directory should not yet exist"
        )

        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        var isDir: ObjCBool = false
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: expectedDir.path, isDirectory: &isDir),
            "NativeMessagingHosts directory should have been created"
        )
        XCTAssertTrue(isDir.boolValue, "NativeMessagingHosts should be a directory")
    }

    func testInstallOverwritesExistingManifest() throws {
        // First install with a stale helper path/extension id.
        let staleBinary = tempDir.appendingPathComponent("stale-binary")
        FileManager.default.createFile(
            atPath: staleBinary.path,
            contents: Data("old\n".utf8),
            attributes: nil
        )
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: staleBinary,
            extensionIds: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            homeDirectory: mockHome,
            fileManager: .default
        )

        // Re-install with the canonical helper binary and placeholder id.
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        let data = try Data(contentsOf: manifestUrl)
        let parsed = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        XCTAssertEqual(
            parsed["path"] as? String,
            NativeMessagingInstaller.launcherScriptPath(under: mockHome).path,
            "second install should overwrite the stale path"
        )
        XCTAssertEqual(
            parsed["allowed_origins"] as? [String],
            [placeholderAllowedOrigin],
            "second install should overwrite the stale allowed_origins"
        )
    }

    func testInstallRejectsMissingHelperBinary() {
        let missingBinary = tempDir.appendingPathComponent("does-not-exist")

        XCTAssertThrowsError(
            try NativeMessagingInstaller.installChromeManifest(
                helperBinaryPath: missingBinary,
                extensionIds: [placeholderExtensionId],
                homeDirectory: mockHome,
                fileManager: .default
            )
        ) { error in
            guard case NativeMessagingInstaller.InstallError.helperBinaryMissing(let url) = error else {
                XCTFail("expected helperBinaryMissing, got \(error)")
                return
            }
            XCTAssertEqual(url.path, missingBinary.path)
        }

        // The installer must not leave behind a partial manifest when
        // the helper is missing.
        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: manifestUrl.path),
            "manifest must not be written when helper is missing"
        )
    }

    // MARK: - Gatekeeper

    func testInstallSkipsWhenGatekeeperRejectsHelper() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default,
            gatekeeperAssessment: { _ in false }
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: manifestUrl.path),
            "manifest must not be written when Gatekeeper rejects the helper"
        )
    }

    func testInstallPreservesExistingManifestWhenGatekeeperRejectsHelper() throws {
        // First install a working manifest (e.g. from a prior manual
        // setup pointing at a sh-wrapper that Gatekeeper trusts).
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default,
            gatekeeperAssessment: { _ in true }
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        let originalData = try Data(contentsOf: manifestUrl)

        // A later install whose bundled helper is Gatekeeper-rejected
        // (e.g. a local dev build of the macOS app on top of a manual
        // install) must not clobber the working manifest.
        let rejectedBinary = tempDir.appendingPathComponent("rejected-binary")
        FileManager.default.createFile(
            atPath: rejectedBinary.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: NSNumber(value: 0o755)]
        )
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: rejectedBinary,
            extensionIds: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
            homeDirectory: mockHome,
            fileManager: .default,
            gatekeeperAssessment: { _ in false }
        )

        let afterData = try Data(contentsOf: manifestUrl)
        XCTAssertEqual(
            originalData,
            afterData,
            "existing manifest must be left untouched when Gatekeeper rejects the new helper"
        )
    }

    // MARK: - uninstall

    func testUninstallRemovesManifest() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionIds: [placeholderExtensionId],
            homeDirectory: mockHome,
            fileManager: .default
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        let launcherUrl = NativeMessagingInstaller.launcherScriptPath(under: mockHome)
        XCTAssertTrue(FileManager.default.fileExists(atPath: manifestUrl.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: launcherUrl.path))

        try NativeMessagingInstaller.uninstallChromeManifest(
            homeDirectory: mockHome,
            fileManager: .default
        )

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: manifestUrl.path),
            "manifest should be removed after uninstall"
        )
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: launcherUrl.path),
            "launcher should be removed after uninstall"
        )
    }

    func testUninstallIsNoOpWhenManifestMissing() {
        // Precondition: no install happened, so no manifest on disk.
        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifestUrl.path))

        XCTAssertNoThrow(
            try NativeMessagingInstaller.uninstallChromeManifest(
                homeDirectory: mockHome,
                fileManager: .default
            )
        )
    }

    // MARK: - manifestDirectory

    func testManifestDirectoryMatchesChromeExpectedLayout() {
        let dir = NativeMessagingInstaller.manifestDirectory(under: mockHome)
        let relative = dir.path.replacingOccurrences(of: mockHome.path, with: "")

        // Chrome's documented location for per-user native messaging
        // host manifests on macOS. Any drift from this layout will
        // break `chrome.runtime.connectNative("com.vellum.daemon")`.
        XCTAssertEqual(
            relative,
            "/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        )
    }
}
