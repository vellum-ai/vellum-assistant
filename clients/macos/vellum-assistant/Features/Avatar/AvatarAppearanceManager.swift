import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AvatarAppearanceManager")

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
    /// then character avatar from saved traits, then bundled V logo, then initial letter.
    var chatAvatarImage: NSImage {
        if let custom = customAvatarImage {
            if let cached = cachedChatAvatar { return cached }
            let resized = Self.resizedImage(custom, to: 56)
            cachedChatAvatar = resized
            return resized
        }

        // Use character avatar from saved traits if available.
        if let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor {
            if let cached = cachedFallbackAvatar { return cached }
            let avatar = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color, size: 56)
            cachedFallbackAvatar = avatar
            return avatar
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
    /// then character avatar from saved traits, then bundled V logo, then initial letter.
    var fullAvatarImage: NSImage {
        if let custom = customAvatarImage { return custom }

        // Use character avatar from saved traits if available.
        if let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor {
            if let cached = cachedFullFallbackAvatar { return cached }
            let avatar = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color, size: 240)
            cachedFullFallbackAvatar = avatar
            return avatar
        }

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

    var customAvatarURL: URL {
        // Resolve from the connected assistant's workspace dir so multi-instance
        // setups (e.g. XDG-based paths) find the correct avatar file.
        if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
           let assistant = LockfileAssistant.loadByName(assistantId),
           let workspace = assistant.workspaceDir {
            return URL(fileURLWithPath: workspace)
                .appendingPathComponent("data/avatar/avatar-image.png")
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
        // Avatar is fetched later via reloadAvatar() once the gateway is
        // confirmed ready. Fetching here would race the daemon startup and
        // clear the avatar to nil on connection-refused, falling back to the
        // bundled Vellum logo.
        updateDockLabel()

        // Fire-and-forget: fetch character component definitions via the
        // gateway and populate AvatarComponentStore.shared so downstream
        // code can look up definitions by ID. Avatar rendering requires
        // the component store to be populated; safe defaults are used
        // during the pre-fetch window.
        Task { [weak self] in
            await self?.fetchComponents()
        }

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
                self.updateDockLabel()
            }
        }
    }

    // MARK: - Component Fetch

    /// Fetches the canonical character component definitions via the gateway
    /// and populates `AvatarComponentStore.shared` for O(1) lookups.
    /// Fails silently — avatar rendering uses safe defaults until the store is populated.
    private func fetchComponents() async {
        if let response = await AvatarComponentService.fetch() {
            AvatarComponentStore.shared.load(response)
        }
    }

    // MARK: - Remote Avatar Fetch (Docker/remote instances)

    /// Fetches the avatar image via HTTP through the gateway for Docker/remote instances.
    private func fetchAvatarViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/workspace/file/content",
                params: ["path": "data/avatar/avatar-image.png"],
                timeout: 10
            )
            guard response.isSuccess, !response.data.isEmpty else {
                customAvatarImage = nil
                cachedChatAvatar = nil
                updateDockIcon()
                return
            }
            cachedChatAvatar = nil
            customAvatarImage = NSImage(data: response.data)
            updateDockIcon()
        } catch {
            log.warning("Failed to fetch avatar via HTTP: \(error.localizedDescription)")
            customAvatarImage = nil
            cachedChatAvatar = nil
            updateDockIcon()
        }
    }

    /// Fetches character-traits.json via HTTP through the gateway for Docker/remote instances.
    private func fetchTraitsViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/workspace/file/content",
                params: ["path": "data/avatar/character-traits.json"],
                timeout: 10
            )
            guard response.isSuccess, !response.data.isEmpty else {
                characterBodyShape = nil
                characterEyeStyle = nil
                characterColor = nil
                cachedFallbackAvatar = nil
                cachedFullFallbackAvatar = nil
                updateDockIcon()
                return
            }
            guard let components = try? JSONDecoder().decode(AvatarComponents.self, from: response.data) else {
                return
            }
            characterBodyShape = AvatarBodyShape(rawValue: components.bodyShape)
            characterEyeStyle = AvatarEyeStyle(rawValue: components.eyeStyle)
            characterColor = AvatarColor(rawValue: components.color)
            cachedFallbackAvatar = nil
            cachedFullFallbackAvatar = nil
            updateDockIcon()
        } catch {
            log.warning("Failed to fetch character traits via HTTP: \(error.localizedDescription)")
            characterBodyShape = nil
            characterEyeStyle = nil
            characterColor = nil
            cachedFallbackAvatar = nil
            cachedFullFallbackAvatar = nil
            updateDockIcon()
        }
    }

    // MARK: - Custom Avatar

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

    /// Reloads the custom avatar and refreshes the assistant name.
    /// Called when the daemon notifies that the avatar image has been
    /// regenerated (via `avatar_updated` event), after reconnection
    /// (`proceedToApp`), and after assistant switches.
    /// Invalidates all cached images so SwiftUI views pick up the new avatar,
    /// and re-reads the identity so the dock label reflects the current assistant.
    /// Fetches via HTTP through the gateway for consistency across all instance types.
    func reloadAvatar() {
        reloadAvatar(avatarPath: nil)
    }

    /// Reloads the avatar, optionally using a local file path for an immediate
    /// dock-icon update before the HTTP round-trip completes.
    /// - Parameter avatarPath: Absolute path to the updated avatar image
    ///   (from the daemon's `avatar_updated` event). When non-nil and the file
    ///   is readable, the dock icon updates immediately; the subsequent HTTP
    ///   fetch still runs to keep all cached state consistent.
    func reloadAvatar(avatarPath: String?) {
        assistantName = AssistantDisplayName.resolve(
            IdentityInfo.load()?.name,
            fallback: "V"
        )
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFallbackName = nil
        cachedFullFallbackAvatar = nil
        cachedFullFallbackName = nil

        // Fast path: load the image directly from disk so the dock icon
        // reflects the new avatar immediately, without waiting for the
        // HTTP round-trip through the gateway.
        if let avatarPath, let image = NSImage(contentsOfFile: avatarPath) {
            customAvatarImage = image
            updateDockIcon()
        }

        Task { [weak self] in
            await self?.fetchAvatarViaHTTP()
            await self?.fetchTraitsViaHTTP()
        }
        updateDockLabel()
    }

    /// Clears all cached avatar state and resets the dock icon to the default
    /// bundle icon without deleting any files on disk.
    /// Called during logout, retire, and switch-assistant flows.
    func resetForDisconnect() {
        customAvatarImage = nil
        characterBodyShape = nil
        characterEyeStyle = nil
        characterColor = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFallbackName = nil
        cachedFullFallbackAvatar = nil
        cachedFullFallbackName = nil
        assistantName = "V"
        updateDockIcon()
        updateDockLabel()
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

    // MARK: - Dock Icon

    /// Posted whenever the avatar changes so other components (e.g. menu bar icon) can update.
    static let avatarDidChangeNotification = Notification.Name("AvatarAppearanceManager.avatarDidChange")

    /// Updates the application dock icon to match the current avatar.
    /// Uses the custom avatar PNG when available, falls back to a character
    /// avatar rendered from saved traits, then reverts to the default bundle icon.
    private func updateDockIcon() {
        NotificationCenter.default.post(name: Self.avatarDidChangeNotification, object: nil)

        // Prefer custom avatar PNG, then character avatar from saved traits.
        let avatar: NSImage
        if let custom = customAvatarImage {
            avatar = custom
        } else if let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor {
            avatar = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color, size: 512)
        } else {
            NSApplication.shared.applicationIconImage = nil
            NSApp.dockTile.display()
            return
        }

        // Standard macOS icons have ~10% padding so the artwork doesn't crowd
        // the dock running-indicator dot or produce edge fringe artifacts.
        let canvasSize: CGFloat = 512
        let iconSize: CGFloat = 418  // ~82% of canvas, matching Apple icon grid
        let padding = (canvasSize - iconSize) / 2
        let squircle = Self.squircleIcon(avatar, size: iconSize)

        let icon = NSImage(size: NSSize(width: canvasSize, height: canvasSize), flipped: false) { _ in
            let iconRect = NSRect(x: padding, y: padding, width: iconSize, height: iconSize)
            squircle.draw(in: iconRect, from: NSRect(origin: .zero, size: squircle.size),
                          operation: .copy, fraction: 1.0)
            return true
        }

        NSApplication.shared.applicationIconImage = icon
        NSApp.dockTile.display()
    }

    /// Renders the source image inside a macOS-style squircle mask at the given point size.
    /// Resolution-independent: the drawing handler is re-invoked at the correct pixel density
    /// for each display context (e.g. 2x on Retina).
    nonisolated static func squircleIcon(_ source: NSImage, size: CGFloat) -> NSImage {
        let square = resizedImage(source, to: size)
        let iconSize = NSSize(width: size, height: size)
        return NSImage(size: iconSize, flipped: false) { rect in
            let radius = size * 0.23
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).addClip()
            square.draw(in: rect, from: NSRect(origin: .zero, size: square.size),
                        operation: .copy, fraction: 1.0)
            return true
        }
    }

    // MARK: - Dock Label

    /// Default app name used for the dock label when no assistant is connected.
    private static let defaultDockLabel = "Vellum"

    /// Sentinel file that `build.sh` reads at build time to set
    /// `CFBundleDisplayName` so the Dock shows the assistant name from
    /// the very first launch after a rebuild.
    private static let dockDisplayNameURL: URL = {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".vellum/.dock-display-name")
    }()

    /// Persists the dock label so `build.sh` can embed it into
    /// `CFBundleDisplayName` at build time.
    ///
    /// NOTE: We intentionally do NOT modify the running bundle's Info.plist
    /// at runtime — doing so invalidates the app's code signature, breaking
    /// TCC permissions (Accessibility, Screen Recording, Microphone) and
    /// Gatekeeper. The dock label only takes effect after a rebuild.
    private func updateDockLabel() {
        let label = assistantName != "V" ? assistantName : Self.defaultDockLabel

        let dir = Self.dockDisplayNameURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? label.write(to: Self.dockDisplayNameURL, atomically: true, encoding: .utf8)
    }

    // MARK: - Image Utilities

    /// Resize an NSImage to a square of the given point size using aspect-fill:
    /// scales the source to fully cover the target square, then crops the excess
    /// so non-square images are centered rather than stretched.
    nonisolated static func resizedImage(_ source: NSImage, to size: CGFloat) -> NSImage {
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

        return NSImage(size: targetSize, flipped: false) { rect in
            source.draw(in: rect, from: cropRect, operation: .copy, fraction: 1.0)
            return true
        }
    }

    // MARK: - Initial Letter Avatar

    /// Build a colored-circle NSImage with the assistant's initial letter as fallback avatar.
    static func buildInitialLetterAvatar(name: String, size: CGFloat = 56) -> NSImage {
        let initial = String(name.prefix(1)).uppercased()
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size * 0.45, weight: .semibold),
            .foregroundColor: NSColor(VColor.auxWhite)
        ]
        let attrStr = NSAttributedString(string: initial, attributes: attrs)
        let textSize = attrStr.size()

        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            NSColor(VColor.primaryBase).setFill()
            NSBezierPath(ovalIn: rect).fill()
            let textPoint = NSPoint(
                x: (size - textSize.width) / 2,
                y: (size - textSize.height) / 2
            )
            attrStr.draw(at: textPoint)
            return true
        }
    }
}
