import AppKit
import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "BundleSandbox")

/// Manages unpacking shared .vellum bundles into a sandboxed directory.
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
        let allowedHosts: [String]
        let trustTier: String
        let signerKeyId: String?
        let signerDisplayName: String?
        let signerAccount: String?
        let bundleSizeBytes: Int
        let installedAt: String

        init(
            uuid: String,
            name: String,
            description: String?,
            icon: String?,
            entry: String,
            createdAt: String,
            createdBy: String,
            capabilities: [String],
            allowedHosts: [String] = [],
            trustTier: String,
            signerKeyId: String?,
            signerDisplayName: String?,
            signerAccount: String?,
            bundleSizeBytes: Int,
            installedAt: String
        ) {
            self.uuid = uuid
            self.name = name
            self.description = description
            self.icon = icon
            self.entry = entry
            self.createdAt = createdAt
            self.createdBy = createdBy
            self.capabilities = capabilities
            self.allowedHosts = allowedHosts
            self.trustTier = trustTier
            self.signerKeyId = signerKeyId
            self.signerDisplayName = signerDisplayName
            self.signerAccount = signerAccount
            self.bundleSizeBytes = bundleSizeBytes
            self.installedAt = installedAt
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            uuid = try container.decode(String.self, forKey: .uuid)
            name = try container.decode(String.self, forKey: .name)
            description = try container.decodeIfPresent(String.self, forKey: .description)
            icon = try container.decodeIfPresent(String.self, forKey: .icon)
            entry = try container.decode(String.self, forKey: .entry)
            createdAt = try container.decode(String.self, forKey: .createdAt)
            createdBy = try container.decode(String.self, forKey: .createdBy)
            capabilities = try container.decode([String].self, forKey: .capabilities)
            allowedHosts = try container.decodeIfPresent([String].self, forKey: .allowedHosts) ?? []
            trustTier = try container.decode(String.self, forKey: .trustTier)
            signerKeyId = try container.decodeIfPresent(String.self, forKey: .signerKeyId)
            signerDisplayName = try container.decodeIfPresent(String.self, forKey: .signerDisplayName)
            signerAccount = try container.decodeIfPresent(String.self, forKey: .signerAccount)
            bundleSizeBytes = try container.decode(Int.self, forKey: .bundleSizeBytes)
            installedAt = try container.decode(String.self, forKey: .installedAt)
        }
    }

    /// Unpacks a `.vellum` zip file into the sandbox and writes metadata.
    /// Returns the UUID and the directory URL where the contents were extracted.
    static func unpack(
        filePath: String,
        manifest: OpenBundleResponseManifest,
        signatureResult: OpenBundleResponseSignatureResult,
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

        // Reject symlinks and hardlinks that could escape the sandbox.
        try stripUnsafeLinks(in: targetDir)

        log.info("Unpacked bundle to \(targetDir.path)")

        // Write metadata file
        let metadata = BundleMetadata(
            uuid: uuid,
            name: manifest.name,
            description: manifest.description,
            icon: manifest.icon,
            entry: manifest.entry,
            createdAt: manifest.created_at,
            createdBy: manifest.created_by,
            capabilities: manifest.capabilities,
            allowedHosts: manifest.allowed_hosts,
            trustTier: signatureResult.trustTier,
            signerKeyId: signatureResult.signerKeyId,
            signerDisplayName: signatureResult.signerDisplayName,
            signerAccount: signatureResult.signerAccount,
            bundleSizeBytes: bundleSizeBytes,
            installedAt: Date().iso8601String
        )

        let metaPath = sharedAppsDirectory.appendingPathComponent("\(uuid)-meta.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let metaData = try encoder.encode(metadata)
        try metaData.write(to: metaPath)

        log.info("Wrote metadata to \(metaPath.path)")

        // Persist icon.png alongside metadata if it exists in the extracted bundle
        let extractedIcon = targetDir.appendingPathComponent("icon.png")
        if fm.fileExists(atPath: extractedIcon.path) {
            let iconDest = sharedAppsDirectory.appendingPathComponent("\(uuid)-icon.png")
            try? fm.copyItem(at: extractedIcon, to: iconDest)
            log.info("Persisted icon to \(iconDest.path)")
        }

        return (uuid: uuid, directory: targetDir)
    }

    /// Loads the persisted icon image for a given bundle UUID, if available.
    static func iconImage(for uuid: String) -> NSImage? {
        let iconPath = sharedAppsDirectory.appendingPathComponent("\(uuid)-icon.png")
        guard FileManager.default.fileExists(atPath: iconPath.path) else { return nil }
        return NSImage(contentsOf: iconPath)
    }

    /// Walk the extracted directory and remove any symlinks or hardlinks whose
    /// real target falls outside `root`. Throws if any are found (after cleanup).
    private static func stripUnsafeLinks(in root: URL) throws {
        let fm = FileManager.default
        let rootReal = root.resolvingSymlinksInPath().path

        guard let enumerator = fm.enumerator(
            at: root,
            includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .linkCountKey],
            options: [.producesRelativePathURLs]
        ) else { return }

        var removed: [String] = []

        for case let fileURL as URL in enumerator {
            // Use the enumerated URL directly — when .producesRelativePathURLs
            // is not honored the enumerator returns absolute URLs, and
            // re-appending relativePath to root would build a wrong path.
            let absURL = fileURL.baseURL != nil
                ? root.appendingPathComponent(fileURL.relativePath)
                : fileURL

            let label = fileURL.relativePath

            // Treat unreadable files as suspicious — if resourceValues throws
            // (I/O error, permissions, etc.) we must not skip the file and
            // leave a potentially unsafe link on disk unchecked.
            guard let values = try? absURL.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .linkCountKey]) else {
                removed.append(label)
                try? fm.removeItem(at: absURL)
                continue
            }

            if values.isSymbolicLink == true {
                // Resolve and check containment
                let target = absURL.resolvingSymlinksInPath().path
                if target != rootReal && !target.hasPrefix(rootReal + "/") {
                    removed.append(label)
                    try? fm.removeItem(at: absURL)
                }
            } else if values.isRegularFile == true, let linkCount = values.linkCount, linkCount > 1 {
                // Hardlink — can't verify target containment, reject outright
                removed.append(label)
                try? fm.removeItem(at: absURL)
            }
        }

        if !removed.isEmpty {
            log.error("Removed \(removed.count) unsafe link(s) from bundle: \(removed.joined(separator: ", "))")
            // Clean up the whole extraction and abort
            try? fm.removeItem(at: root)
            throw BundleSandboxError.unsafeLinks(removed)
        }
    }

    enum BundleSandboxError: Error, LocalizedError {
        case unzipFailed(String)
        case unsafeLinks([String])

        var errorDescription: String? {
            switch self {
            case .unzipFailed(let output):
                return "Failed to extract bundle: \(output)"
            case .unsafeLinks(let paths):
                return "Bundle contains unsafe symlinks/hardlinks: \(paths.joined(separator: ", "))"
            }
        }
    }
}
