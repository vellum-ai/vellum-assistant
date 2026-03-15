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

    /// The avatar component choices used to build the current character avatar (nil if uploaded image).
    private(set) var characterBodyShape: AvatarBodyShape?
    private(set) var characterEyeStyle: AvatarEyeStyle?
    private(set) var characterColor: AvatarColor?

    /// Cached fallback avatar to avoid rebuilding on every access.
    /// @ObservationIgnored so that populating the cache inside a computed getter
    /// doesn't fire an observation notification and trigger another SwiftUI
    /// view-update pass (which would create a re-render loop).
    @ObservationIgnored private var cachedFallbackAvatar: NSImage?
    /// The name used to build the cached fallback, so we can invalidate when identity changes.
    @ObservationIgnored private var cachedFallbackName: String?
    /// Cached chat-size avatar (56pt for 2x Retina).
    @ObservationIgnored private var cachedChatAvatar: NSImage?
    /// Cached full-size fallback avatar for larger displays (identity panel, constellation).
    @ObservationIgnored private var cachedFullFallbackAvatar: NSImage?
    @ObservationIgnored private var cachedFullFallbackName: String?

    /// Bundled initial avatar loaded once from Resources.
    private static let bundledInitialAvatar: NSImage? = {
        guard let url = ResourceBundle.bundle.url(forResource: "initial-avatar", withExtension: "png") else { return nil }
        return NSImage(contentsOf: url)
    }()

    /// Returns the custom avatar resized for chat (56pt for 2x Retina) if available,
    /// otherwise the bundled initial avatar, or an initial-letter placeholder as last resort.
    var chatAvatarImage: NSImage {
        if let custom = customAvatarImage {
            if let cached = cachedChatAvatar { return cached }
            let resized = Self.resizedImage(custom, to: 56)
            cachedChatAvatar = resized
            return resized
        }

        if let bundled = Self.bundledInitialAvatar {
            if let cached = cachedFallbackAvatar { return cached }
            let resized = Self.resizedImage(bundled, to: 56)
            cachedFallbackAvatar = resized
            return resized
        }

        let name = assistantName
        let avatar = Self.buildInitialLetterAvatar(name: name)
        cachedFallbackAvatar = avatar
        cachedFallbackName = name
        return avatar
    }

    /// Returns the full-size custom avatar for large displays (identity panel, constellation node),
    /// or falls back to the bundled initial avatar, or a larger initial-letter circle.
    var fullAvatarImage: NSImage {
        if let custom = customAvatarImage { return custom }
        if let bundled = Self.bundledInitialAvatar { return bundled }

        let name = assistantName
        if let cached = cachedFullFallbackAvatar, cachedFullFallbackName == name {
            return cached
        }

        let avatar = Self.buildInitialLetterAvatar(name: name, size: 240)
        cachedFullFallbackAvatar = avatar
        cachedFullFallbackName = name
        return avatar
    }

    static let shared = AvatarAppearanceManager()

    private var fileMonitor: DispatchSourceFileSystemObject?
    private var identityObserver: NSObjectProtocol?

    /// Workspace path for custom avatar -- canonical storage location.
    nonisolated static func workspaceCustomAvatarURL(homeDirectory: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: homeDirectory)
            .appendingPathComponent(".vellum/workspace/data/avatar/avatar-image.png")
    }

    /// Legacy Application Support path (pre-workspace migration). Retained for one-time migration on first launch after upgrade.
    nonisolated static func legacyAppSupportCustomAvatarURL() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("custom-avatar.png")
    }

    private var customAvatarURL: URL {
        // Resolve from the connected assistant's baseDataDir so multi-instance
        // setups (e.g. XDG-based paths) find the correct avatar file.
        if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
           let assistant = LockfileAssistant.loadByName(assistantId),
           let baseDataDir = assistant.baseDataDir {
            // baseDataDir is the .vellum root (e.g. ~/.local/share/vellum/assistants/foo/.vellum)
            return URL(fileURLWithPath: baseDataDir)
                .appendingPathComponent("workspace/data/avatar/avatar-image.png")
        }
        return Self.workspaceCustomAvatarURL()
    }

    /// The assistant's display name, loaded once from IDENTITY.md to avoid repeated disk I/O.
    private var assistantName: String = "V"

    func start() {
        assistantName = AssistantDisplayName.resolve(
            IdentityInfo.load()?.name,
            fallback: "V"
        )
        loadCustomAvatar()
        loadAvatarComponents()
        watchAvatarFile()

        // Refresh assistantName and invalidate cached fallback avatars when
        // the user renames their assistant so the initial-letter avatar
        // reflects the new name.
        identityObserver = NotificationCenter.default.addObserver(
            forName: .identityChanged,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.assistantName = AssistantDisplayName.resolve(
                    IdentityInfo.load()?.name,
                    fallback: "V"
                )
                self.cachedFallbackAvatar = nil
                self.cachedFallbackName = nil
                self.cachedFullFallbackAvatar = nil
                self.cachedFullFallbackName = nil
            }
        }
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
        ) else {
            customAvatarImage = nil
            cachedChatAvatar = nil
            updateDockIcon()
            return
        }
        cachedChatAvatar = nil
        customAvatarImage = NSImage(contentsOf: url)
        updateDockIcon()
    }

    func saveAvatar(_ image: NSImage, bodyShape: AvatarBodyShape? = nil, eyeStyle: AvatarEyeStyle? = nil, color: AvatarColor? = nil) {
        let url = customAvatarURL
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else { return }

        try? pngData.write(to: url)
        cachedChatAvatar = nil
        customAvatarImage = image

        // Persist component choices (nil clears them for uploaded images)
        characterBodyShape = bodyShape
        characterEyeStyle = eyeStyle
        characterColor = color
        saveAvatarComponents()
        updateDockIcon()
    }

    /// Reloads the custom avatar from disk. Called when the daemon notifies
    /// that the avatar image has been regenerated (via `avatar_updated` event).
    /// Invalidates all cached images so SwiftUI views pick up the new avatar.
    func reloadAvatar() {
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        loadCustomAvatar()
    }

    func clearCustomAvatar() {
        try? FileManager.default.removeItem(at: customAvatarURL)
        try? FileManager.default.removeItem(at: Self.legacyAppSupportCustomAvatarURL())
        try? FileManager.default.removeItem(at: avatarComponentsURL)
        customAvatarImage = nil
        characterBodyShape = nil
        characterEyeStyle = nil
        characterColor = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        updateDockIcon()
    }

    // MARK: - Avatar Components Persistence

    private var avatarComponentsURL: URL {
        customAvatarURL.deletingLastPathComponent().appendingPathComponent("character-traits.json")
    }

    private struct AvatarComponents: Codable {
        let bodyShape: String
        let eyeStyle: String
        let color: String
    }

    private func saveAvatarComponents() {
        guard let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor else {
            try? FileManager.default.removeItem(at: avatarComponentsURL)
            return
        }
        let components = AvatarComponents(bodyShape: body.rawValue, eyeStyle: eyes.rawValue, color: color.rawValue)
        guard let data = try? JSONEncoder().encode(components) else { return }
        try? data.write(to: avatarComponentsURL)
    }

    private func loadAvatarComponents() {
        guard let data = try? Data(contentsOf: avatarComponentsURL),
              let components = try? JSONDecoder().decode(AvatarComponents.self, from: data) else {
            characterBodyShape = nil
            characterEyeStyle = nil
            characterColor = nil
            return
        }
        characterBodyShape = AvatarBodyShape(rawValue: components.bodyShape)
        characterEyeStyle = AvatarEyeStyle(rawValue: components.eyeStyle)
        characterColor = AvatarColor(rawValue: components.color)
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

    // MARK: - Dock Icon

    /// Updates the application dock icon to match the current avatar.
    /// When a custom avatar exists, renders it inside a macOS-style squircle mask.
    /// When cleared, reverts to the default bundle icon.
    private func updateDockIcon() {
        guard let avatar = customAvatarImage else {
            NSApplication.shared.applicationIconImage = nil
            NSApp.dockTile.display()
            return
        }

        let size: CGFloat = 512
        let square = Self.resizedImage(avatar, to: size)
        let iconSize = NSSize(width: size, height: size)
        let icon = NSImage(size: iconSize)
        icon.lockFocus()

        let rect = NSRect(origin: .zero, size: iconSize)
        let radius = size * 0.23
        let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
        path.addClip()

        square.draw(in: rect, from: NSRect(origin: .zero, size: square.size),
                    operation: .copy, fraction: 1.0)

        icon.unlockFocus()

        NSApplication.shared.applicationIconImage = icon
        NSApp.dockTile.display()
    }

    // MARK: - Image Utilities

    /// Resize an NSImage to a square of the given point size using aspect-fill:
    /// scales the source to fully cover the target square, then crops the excess
    /// so non-square images are centered rather than stretched.
    static func resizedImage(_ source: NSImage, to size: CGFloat) -> NSImage {
        let targetSize = NSSize(width: size, height: size)
        let srcW = source.size.width
        let srcH = source.size.height

        // Determine crop rect: scale so the smaller dimension fills `size`,
        // then center-crop the larger dimension.
        let cropRect: NSRect
        if srcW / srcH > 1 {
            // Wider than tall -- crop horizontal excess
            let cropW = srcH // square side in source coords
            let originX = (srcW - cropW) / 2
            cropRect = NSRect(x: originX, y: 0, width: cropW, height: srcH)
        } else {
            // Taller than wide (or square) -- crop vertical excess
            let cropH = srcW // square side in source coords
            let originY = (srcH - cropH) / 2
            cropRect = NSRect(x: 0, y: originY, width: srcW, height: cropH)
        }

        let resized = NSImage(size: targetSize)
        resized.lockFocus()
        source.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: cropRect,
            operation: .copy,
            fraction: 1.0
        )
        resized.unlockFocus()
        return resized
    }

    // MARK: - Initial Letter Avatar

    /// Build a colored-circle NSImage with the assistant's initial letter as fallback avatar.
    static func buildInitialLetterAvatar(name: String, size: CGFloat = 56) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size))
        image.lockFocus()

        // Draw circle with accent color (VColor.primaryBase equivalent)
        let path = NSBezierPath(ovalIn: NSRect(x: 0, y: 0, width: size, height: size))
        NSColor(VColor.primaryBase).setFill()
        path.fill()

        // Draw initial letter
        let initial = String(name.prefix(1)).uppercased()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size * 0.45, weight: .semibold),
            .foregroundColor: NSColor(VColor.auxWhite)
        ]
        let attrStr = NSAttributedString(string: initial, attributes: attrs)
        let textSize = attrStr.size()
        let textPoint = NSPoint(x: (size - textSize.width) / 2, y: (size - textSize.height) / 2)
        attrStr.draw(at: textPoint)

        image.unlockFocus()
        return image
    }
}
