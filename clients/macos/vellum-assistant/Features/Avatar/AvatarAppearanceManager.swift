import AppKit
import Foundation

/// Loads avatar appearance from LOOKS.md, watches for changes, and provides
/// the current DinoPalette for rendering. @Observable so SwiftUI views reactively update.
@MainActor @Observable
final class AvatarAppearanceManager {
    private(set) var palette: DinoPalette = .violet
    private(set) var outfit: DinoOutfit = .none
    private(set) var config: LooksConfig = .default
    private var fileMonitor: DispatchSourceFileSystemObject?

    /// Pre-rendered 28px blob image for chat avatars, rebuilt when palette changes.
    private(set) var cachedChatAvatarImage: NSImage?
    /// User-uploaded custom avatar image, persisted to disk.
    private(set) var customAvatarImage: NSImage?

    /// Returns the custom avatar if set, otherwise the cached blob.
    var chatAvatarImage: NSImage {
        if let custom = customAvatarImage { return custom }
        if let cached = cachedChatAvatarImage { return cached }
        // Fallback: build on-demand
        return PixelSpriteBuilder.buildBlobNSImage(pixelSize: 2, palette: palette)
    }

    static let shared = AvatarAppearanceManager()

    var looksPath: String {
        NSHomeDirectory() + "/.vellum/workspace/LOOKS.md"
    }

    /// Workspace path for custom avatar — canonical storage location.
    nonisolated static func workspaceCustomAvatarURL(homeDirectory: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: homeDirectory)
            .appendingPathComponent(".vellum/workspace/data/avatar/custom-avatar.png")
    }

    /// Legacy Application Support path (pre-workspace migration). Retained for one-time migration on first launch after upgrade.
    nonisolated static func legacyAppSupportCustomAvatarURL() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("custom-avatar.png")
    }

    private var customAvatarURL: URL {
        Self.workspaceCustomAvatarURL()
    }

    func start() {
        reload()
        loadCustomAvatar()
        watchFile()
    }

    private func reload() {
        guard let content = try? String(contentsOfFile: looksPath, encoding: .utf8) else {
            return
        }
        config = LooksConfig.parse(from: content)
        palette = config.toPalette()
        outfit = config.toOutfit()
        rebuildCachedChatAvatar()
    }

    private func rebuildCachedChatAvatar() {
        cachedChatAvatarImage = PixelSpriteBuilder.buildBlobNSImage(pixelSize: 2, palette: palette)
    }

    // MARK: - Custom Avatar

    /// Resolves which avatar URL to load from, performing one-time migration if needed.
    /// Extracted as a static helper so migration logic is directly testable.
    nonisolated static func resolveCustomAvatarURL(
        workspaceURL: URL,
        legacyURL: URL,
        fileManager: FileManager = .default
    ) -> URL? {
        // One-time migration: copy legacy avatar to workspace if workspace copy doesn't exist
        if !fileManager.fileExists(atPath: workspaceURL.path), fileManager.fileExists(atPath: legacyURL.path) {
            let dir = workspaceURL.deletingLastPathComponent()
            try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
            try? fileManager.copyItem(at: legacyURL, to: workspaceURL)
        }

        if fileManager.fileExists(atPath: workspaceURL.path) {
            return workspaceURL
        } else if fileManager.fileExists(atPath: legacyURL.path) {
            return legacyURL
        }
        return nil
    }

    private func loadCustomAvatar() {
        guard let url = Self.resolveCustomAvatarURL(
            workspaceURL: customAvatarURL,
            legacyURL: Self.legacyAppSupportCustomAvatarURL()
        ) else { return }
        customAvatarImage = NSImage(contentsOf: url)
    }

    func setCustomAvatar(_ image: NSImage) {
        let url = customAvatarURL
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else { return }

        try? pngData.write(to: url)
        customAvatarImage = image
    }

    func clearCustomAvatar() {
        try? FileManager.default.removeItem(at: customAvatarURL)
        try? FileManager.default.removeItem(at: Self.legacyAppSupportCustomAvatarURL())
        customAvatarImage = nil
    }

    private func watchFile() {
        fileMonitor?.cancel()
        fileMonitor = nil

        let path = looksPath
        let fd = open(path, O_EVTONLY)

        if fd < 0 {
            // File doesn't exist yet — watch the parent directory for creation
            watchDirectory()
            return
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            let flags = source.data
            Task { @MainActor [weak self] in
                self?.reload()
                // Re-watch in case of delete+recreate
                if flags.contains(.delete) || flags.contains(.rename) {
                    self?.watchFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    /// Watches the workspace directory for LOOKS.md creation, then switches to file-level watching.
    private func watchDirectory() {
        let dirPath = (looksPath as NSString).deletingLastPathComponent
        let fd = open(dirPath, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: .write,
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if FileManager.default.fileExists(atPath: self.looksPath) {
                    self.reload()
                    self.watchFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    // MARK: - Evolution Write-Back

    /// Write a resolved LooksConfig to LOOKS.md.
    /// Only writes if the config actually changed from current.
    func applyEvolutionResult(_ newConfig: LooksConfig) {
        guard newConfig != config else { return }

        let content = """
        - **Body:** \(newConfig.bodyColor)
        - **Cheeks:** \(newConfig.cheekColor)
        - **Hat:** \(formatOutfitField(newConfig.hat, color: newConfig.hatColor))
        - **Shirt:** \(formatOutfitField(newConfig.shirt, color: newConfig.shirtColor))
        - **Accessory:** \(formatOutfitField(newConfig.accessory, color: newConfig.accessoryColor))
        - **Held Item:** \(newConfig.heldItem)
        """

        try? content.write(toFile: looksPath, atomically: true, encoding: .utf8)

        // Apply in-process immediately instead of waiting for the file watcher round-trip.
        // The file watcher still handles external edits to LOOKS.md.
        config = newConfig
        palette = newConfig.toPalette()
        outfit = newConfig.toOutfit()
        rebuildCachedChatAvatar()
    }

    private func formatOutfitField(_ item: String, color: String?) -> String {
        if let color = color, color != "none" {
            return "\(item) (\(color))"
        }
        return item
    }
}
