import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "BundleSandbox")

/// Manages unpacking shared .vellumapp bundles into a sandboxed directory.
enum BundleSandbox {

    /// Base directory for all shared apps.
    static var sharedAppsDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")
        return appSupport
            .appendingPathComponent("vellum-assistant")
            .appendingPathComponent("shared-apps")
    }

    /// Metadata file stored alongside the unpacked bundle.
    struct BundleMetadata: Codable {
        let uuid: String
        let name: String
        let description: String?
        let icon: String?
        let entry: String
        let createdAt: String
        let createdBy: String
        let capabilities: [String]
        let trustTier: String
        let signerKeyId: String?
        let signerDisplayName: String?
        let signerAccount: String?
        let bundleSizeBytes: Int
        let installedAt: String
    }

    /// Unpacks a `.vellumapp` zip file into the sandbox and writes metadata.
    /// Returns the UUID and the directory URL where the contents were extracted.
    static func unpack(
        filePath: String,
        manifest: OpenBundleResponseMessage.Manifest,
        signatureResult: OpenBundleResponseMessage.SignatureResult,
        bundleSizeBytes: Int
    ) throws -> (uuid: String, directory: URL) {
        let uuid = UUID().uuidString.lowercased()
        let targetDir = sharedAppsDirectory.appendingPathComponent(uuid)

        let fm = FileManager.default

        // Create the target directory
        try fm.createDirectory(at: targetDir, withIntermediateDirectories: true, attributes: nil)

        // Extract the zip using the `unzip` command
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-o", "-q", filePath, "-d", targetDir.path]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        try process.run()

        // Read pipe data before waitUntilExit to avoid deadlock when
        // the pipe buffer fills up and the subprocess blocks on write.
        let outputData = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0 else {
            let output = String(data: outputData, encoding: .utf8) ?? ""
            log.error("unzip failed with status \(process.terminationStatus): \(output)")
            // Clean up on failure
            try? fm.removeItem(at: targetDir)
            throw BundleSandboxError.unzipFailed(output)
        }

        log.info("Unpacked bundle to \(targetDir.path)")

        // Write metadata file
        let metadata = BundleMetadata(
            uuid: uuid,
            name: manifest.name,
            description: manifest.description,
            icon: manifest.icon,
            entry: manifest.entry,
            createdAt: manifest.createdAt,
            createdBy: manifest.createdBy,
            capabilities: manifest.capabilities,
            trustTier: signatureResult.trustTier,
            signerKeyId: signatureResult.signerKeyId,
            signerDisplayName: signatureResult.signerDisplayName,
            signerAccount: signatureResult.signerAccount,
            bundleSizeBytes: bundleSizeBytes,
            installedAt: ISO8601DateFormatter().string(from: Date())
        )

        let metaPath = sharedAppsDirectory.appendingPathComponent("\(uuid)-meta.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let metaData = try encoder.encode(metadata)
        try metaData.write(to: metaPath)

        log.info("Wrote metadata to \(metaPath.path)")

        return (uuid: uuid, directory: targetDir)
    }

    enum BundleSandboxError: Error, LocalizedError {
        case unzipFailed(String)

        var errorDescription: String? {
            switch self {
            case .unzipFailed(let output):
                return "Failed to extract bundle: \(output)"
            }
        }
    }
}
