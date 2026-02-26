import AppKit
import Foundation
import VellumAssistantShared

/// Manages the assistant's avatar image. Provides a custom avatar when uploaded,
/// or falls back to a colored circle with the assistant's initial letter.
/// @Observable so SwiftUI views reactively update.
@MainActor @Observable
final class AvatarAppearanceManager {
    /// User-uploaded custom avatar image, persisted to disk.
    private(set) var customAvatarImage: NSImage?

    /// Cached fallback avatar to avoid rebuilding on every access.
    private var cachedFallbackAvatar: NSImage?
    /// The name used to build the cached fallback, so we can invalidate when identity changes.
    private var cachedFallbackName: String?

    /// Returns the custom avatar if set, otherwise an initial-letter placeholder (cached).
    var chatAvatarImage: NSImage {
        if let custom = customAvatarImage { return custom }

        let name = assistantName
        if let cached = cachedFallbackAvatar, cachedFallbackName == name {
            return cached
        }

        let avatar = Self.buildInitialLetterAvatar(name: name)
        cachedFallbackAvatar = avatar
        cachedFallbackName = name
        return avatar
    }

    static let shared = AvatarAppearanceManager()

    private var fileMonitor: DispatchSourceFileSystemObject?

    /// Workspace path for custom avatar -- canonical storage location.
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

    /// The assistant's display name, loaded once from IDENTITY.md to avoid repeated disk I/O.
    private var assistantName: String = "V"

    func start() {
        assistantName = IdentityInfo.load()?.name ?? "V"
        loadCustomAvatar()
        watchAvatarFile()
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

    /// Reloads the custom avatar from disk. Called when the daemon notifies
    /// that the avatar image has been regenerated (via `avatar_updated` IPC).
    func reloadAvatar() {
        loadCustomAvatar()
    }

    func clearCustomAvatar() {
        try? FileManager.default.removeItem(at: customAvatarURL)
        try? FileManager.default.removeItem(at: Self.legacyAppSupportCustomAvatarURL())
        customAvatarImage = nil
        cachedFallbackAvatar = nil
    }

    // MARK: - File Watching

    /// Watch the custom avatar PNG for external changes (e.g. user replaces the file manually).
    private func watchAvatarFile() {
        fileMonitor?.cancel()
        fileMonitor = nil

        let path = customAvatarURL.path
        let fd = open(path, O_EVTONLY)

        if fd < 0 {
            watchAvatarDirectory()
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
                self?.loadCustomAvatar()
                if flags.contains(.delete) || flags.contains(.rename) {
                    self?.watchAvatarFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    /// Watch the avatar directory for file creation when the avatar file doesn't exist yet.
    private func watchAvatarDirectory() {
        let dirPath = (customAvatarURL.path as NSString).deletingLastPathComponent
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
                if FileManager.default.fileExists(atPath: self.customAvatarURL.path) {
                    self.loadCustomAvatar()
                    self.watchAvatarFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    // MARK: - Initial Letter Avatar

    /// Build a 56px NSImage with a colored circle and white initial letter as fallback avatar.
    static func buildInitialLetterAvatar(name: String, size: CGFloat = 56) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()

        // Draw circle with accent color (Forest._600 equivalent)
        let path = NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size))
        NSColor(Forest._600).setFill()
        path.fill()

        // Draw initial letter
        let initial = String(name.prefix(1)).uppercased()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size * 0.45, weight: .semibold),
            .foregroundColor: NSColor.white
        ]
        let attrStr = NSAttributedString(string: initial, attributes: attrs)
        let textSize = attrStr.size()
        let textPoint = NSPoint(x: (size - textSize.width) / 2, y: (size - textSize.height) / 2)
        attrStr.draw(at: textPoint)

        image.unlockFocus()
        return image
    }
}
