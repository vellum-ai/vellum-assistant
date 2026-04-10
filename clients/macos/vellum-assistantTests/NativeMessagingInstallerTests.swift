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
            extensionId: placeholderExtensionId,
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
        XCTAssertEqual(parsed["path"] as? String, helperBinaryUrl.path)

        let origins = try XCTUnwrap(parsed["allowed_origins"] as? [String])
        XCTAssertEqual(origins, [placeholderAllowedOrigin])
    }

    func testInstallSetsManifestPermissionsTo0o644() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionId: placeholderExtensionId,
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

    func testInstallCreatesIntermediateNativeMessagingHostsDirectory() throws {
        // Sanity: the mock home starts without a Chrome subtree.
        let expectedDir = NativeMessagingInstaller.manifestDirectory(under: mockHome)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: expectedDir.path),
            "precondition: NativeMessagingHosts directory should not yet exist"
        )

        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionId: placeholderExtensionId,
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
            extensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            homeDirectory: mockHome,
            fileManager: .default
        )

        // Re-install with the canonical helper binary and placeholder id.
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionId: placeholderExtensionId,
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
            helperBinaryUrl.path,
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
                extensionId: placeholderExtensionId,
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

    // MARK: - uninstall

    func testUninstallRemovesManifest() throws {
        try NativeMessagingInstaller.installChromeManifest(
            helperBinaryPath: helperBinaryUrl,
            extensionId: placeholderExtensionId,
            homeDirectory: mockHome,
            fileManager: .default
        )

        let manifestUrl = NativeMessagingInstaller
            .manifestDirectory(under: mockHome)
            .appendingPathComponent("com.vellum.daemon.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: manifestUrl.path))

        try NativeMessagingInstaller.uninstallChromeManifest(
            homeDirectory: mockHome,
            fileManager: .default
        )

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: manifestUrl.path),
            "manifest should be removed after uninstall"
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
