import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AvatarAppearanceManager")

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
    /// Cached transparency flags for chat and full avatars.
    /// Leverages domain knowledge: character avatars are always transparent
    /// (drawn on a clear canvas), initial-letter avatars are always opaque
    /// (filled circle). Only custom uploads need actual pixel inspection.
    @ObservationIgnored private var cachedChatAvatarTransparent: Bool?
    @ObservationIgnored private var cachedFullAvatarTransparent: Bool?

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

    /// Whether the chat-size avatar has a transparent background.
    /// Computed once per image change and cached — safe to read in view bodies.
    var isChatAvatarTransparent: Bool {
        if let cached = cachedChatAvatarTransparent { return cached }
        let result = resolveTransparency(for: chatAvatarImage)
        cachedChatAvatarTransparent = result
        return result
    }

    /// Whether the full-size avatar has a transparent background.
    /// Computed once per image change and cached — safe to read in view bodies.
    var isFullAvatarTransparent: Bool {
        if let cached = cachedFullAvatarTransparent { return cached }
        let result = resolveTransparency(for: fullAvatarImage)
        cachedFullAvatarTransparent = result
        return result
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

    /// The assistant's display name, loaded once from IDENTITY.md to avoid repeated disk I/O.
    private var assistantName: String = "V"
    /// Tracked identity-load task so resetForDisconnect can cancel in-flight loads.
    @ObservationIgnored private var identityLoadTask: Task<Void, Never>?

    func start() {
        identityLoadTask = Task {
            let info = await IdentityInfo.loadAsync()
            guard !Task.isCancelled else { return }
            assistantName = AssistantDisplayName.resolve(info?.name, fallback: "V")
            updateDockLabel()
        }
        // Avatar is fetched later via reloadAvatar() once the gateway is
        // confirmed ready. Fetching here would race the daemon startup and
        // clear the avatar to nil on connection-refused, falling back to the
        // bundled Vellum logo.

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
                let info = await IdentityInfo.loadAsync()
                self.assistantName = AssistantDisplayName.resolve(info?.name, fallback: "V")
                self.cachedFallbackAvatar = nil
                self.cachedFallbackName = nil
                self.cachedFullFallbackAvatar = nil
                self.cachedFullFallbackName = nil
                self.cachedChatAvatarTransparent = nil
                self.cachedFullAvatarTransparent = nil
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

    // MARK: - Avatar Fetch via Gateway

    /// Fetches the avatar image via HTTP through the gateway.
    private func fetchAvatarViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/workspace/file/content",
                params: ["path": "data/avatar/avatar-image.png"],
                timeout: 10
            )
            guard response.isSuccess, !response.data.isEmpty else {
                if customAvatarImage != nil { customAvatarImage = nil }
                cachedChatAvatar = nil
                cachedChatAvatarTransparent = nil
                cachedFullAvatarTransparent = nil
                updateDockIcon()
                return
            }
            cachedChatAvatar = nil
            cachedChatAvatarTransparent = nil
            cachedFullAvatarTransparent = nil
            customAvatarImage = NSImage(data: response.data)
            updateDockIcon()
        } catch {
            log.warning("Failed to fetch avatar via HTTP: \(error.localizedDescription)")
            if customAvatarImage != nil { customAvatarImage = nil }
            cachedChatAvatar = nil
            cachedChatAvatarTransparent = nil
            cachedFullAvatarTransparent = nil
            updateDockIcon()
        }
    }

    /// Fetches character-traits.json via HTTP through the gateway.
    private func fetchTraitsViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/workspace/file/content",
                params: ["path": "data/avatar/character-traits.json"],
                timeout: 10
            )
            guard response.isSuccess, !response.data.isEmpty else {
                if characterBodyShape != nil { characterBodyShape = nil }
                if characterEyeStyle != nil { characterEyeStyle = nil }
                if characterColor != nil { characterColor = nil }
                cachedFallbackAvatar = nil
                cachedFullFallbackAvatar = nil
                cachedChatAvatarTransparent = nil
                cachedFullAvatarTransparent = nil
                updateDockIcon()
                return
            }
            guard let components = try? JSONDecoder().decode(AvatarComponents.self, from: response.data) else {
                return
            }
            characterBodyShape = AvatarBodyShape(rawValue: components.bodyShape)
            characterEyeStyle = AvatarEyeStyle(rawValue: components.eyeStyle)
            characterColor = AvatarColor(rawValue: components.color)
            // Character traits loaded — the PNG is just a daemon rendering
            // of the character, not a user upload. Clear it so the animated
            // path is used.
            customAvatarImage = nil
            cachedChatAvatar = nil
            cachedFallbackAvatar = nil
            cachedFullFallbackAvatar = nil
            cachedChatAvatarTransparent = nil
            cachedFullAvatarTransparent = nil
            updateDockIcon()
        } catch {
            log.warning("Failed to fetch character traits via HTTP: \(error.localizedDescription)")
            if characterBodyShape != nil { characterBodyShape = nil }
            if characterEyeStyle != nil { characterEyeStyle = nil }
            if characterColor != nil { characterColor = nil }
            cachedFallbackAvatar = nil
            cachedFullFallbackAvatar = nil
            cachedChatAvatarTransparent = nil
            cachedFullAvatarTransparent = nil
            updateDockIcon()
        }
    }

    // MARK: - Custom Avatar

    func saveAvatar(_ image: NSImage, bodyShape: AvatarBodyShape? = nil, eyeStyle: AvatarEyeStyle? = nil, color: AvatarColor? = nil) {
        let isCharacter = bodyShape != nil

        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else { return }

        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        cachedChatAvatarTransparent = nil
        cachedFullAvatarTransparent = nil

        if isCharacter {
            // Character save: set traits, clear the custom image so
            // AnimatedAvatarView is used instead of the static PNG.
            customAvatarImage = nil
            characterBodyShape = bodyShape
            characterEyeStyle = eyeStyle
            characterColor = color
        } else {
            // Custom upload: set the image, clear character traits so
            // the static VAvatarImage path is used.
            customAvatarImage = image
            characterBodyShape = nil
            characterEyeStyle = nil
            characterColor = nil
        }
        updateDockIcon()

        // Persist to the assistant's workspace via the gateway.
        Task {
            let workspaceClient = WorkspaceClient()
            _ = await workspaceClient.createWorkspaceDirectory(path: "data/avatar")
            _ = await workspaceClient.writeWorkspaceFile(path: "data/avatar/avatar-image.png", content: pngData)
            saveAvatarComponentsViaGateway()
        }
    }

    /// Reloads the avatar by fetching the latest state from the assistant
    /// daemon via the gateway. Called on `avatar_updated` events, after
    /// reconnection, and after assistant switches.
    /// Invalidates all cached images so SwiftUI views pick up the new avatar,
    /// and re-reads the identity so the dock label reflects the current assistant.
    func reloadAvatar() {
        reloadAvatar(avatarPath: nil)
    }

    /// Reloads the avatar. The `avatarPath` parameter is accepted for
    /// backward compatibility with the daemon's `avatar_updated` event
    /// payload but is not used — all data is fetched via the gateway.
    func reloadAvatar(avatarPath: String?) {
        identityLoadTask?.cancel()
        identityLoadTask = Task {
            let info = await IdentityInfo.loadAsync()
            guard !Task.isCancelled else { return }
            assistantName = AssistantDisplayName.resolve(info?.name, fallback: "V")
            updateDockLabel()
        }
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFallbackName = nil
        cachedFullFallbackAvatar = nil
        cachedFullFallbackName = nil
        cachedChatAvatarTransparent = nil
        cachedFullAvatarTransparent = nil

        Task { [weak self] in
            await self?.fetchComponents()
            await self?.fetchAvatarViaHTTP()
            await self?.fetchTraitsViaHTTP()
        }
    }

    /// Posts character traits to the daemon via the gateway so the daemon
    /// renders and persists the avatar in its workspace. Used after onboarding
    /// to sync the randomly-generated avatar to the daemon (especially
    /// important for managed/remote assistants where the filesystem is not shared).
    /// Fires `reloadAvatar()` on success so cached state picks up the daemon's
    /// rendered image.
    func syncTraitsToDaemon(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor) async {
        let json: [String: Any] = [
            "bodyShape": bodyShape.rawValue,
            "eyeStyle": eyeStyle.rawValue,
            "color": color.rawValue,
        ]
        log.info("[avatarSync] syncTraitsToDaemon: posting \(bodyShape.rawValue)/\(eyeStyle.rawValue)/\(color.rawValue)")
        // Retry up to 3 times with a short delay for transient failures
        // (e.g. 500 from a freshly-hatched assistant that isn't fully ready).
        for attempt in 1...3 {
            do {
                let response = try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/avatar/render-from-traits",
                    json: json,
                    timeout: 15
                )
                if response.isSuccess {
                    log.info("[avatarSync] syncTraitsToDaemon: success on attempt \(attempt)")
                    reloadAvatar()
                    return
                } else if response.statusCode >= 500 && attempt < 3 {
                    log.warning("[avatarSync] syncTraitsToDaemon: HTTP \(response.statusCode) on attempt \(attempt), retrying...")
                    try await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
                    continue
                } else {
                    log.warning("[avatarSync] syncTraitsToDaemon: HTTP \(response.statusCode) on attempt \(attempt), giving up")
                    return
                }
            } catch {
                log.warning("[avatarSync] syncTraitsToDaemon: error on attempt \(attempt): \(error.localizedDescription)")
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
                }
            }
        }
    }

    /// Clears all cached avatar state and resets the dock icon to the default
    /// bundle icon without deleting any files on disk.
    /// Called during logout, retire, and switch-assistant flows.
    func resetForDisconnect() {
        identityLoadTask?.cancel()
        identityLoadTask = nil
        customAvatarImage = nil
        characterBodyShape = nil
        characterEyeStyle = nil
        characterColor = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFallbackName = nil
        cachedFullFallbackAvatar = nil
        cachedFullFallbackName = nil
        cachedChatAvatarTransparent = nil
        cachedFullAvatarTransparent = nil
        assistantName = "V"
        updateDockIcon()
        updateDockLabel()
    }

    func clearCustomAvatar() {
        customAvatarImage = nil
        characterBodyShape = nil
        characterEyeStyle = nil
        characterColor = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        cachedChatAvatarTransparent = nil
        cachedFullAvatarTransparent = nil
        updateDockIcon()

        // Remove files from the assistant's workspace via the gateway.
        Task {
            let workspaceClient = WorkspaceClient()
            _ = await workspaceClient.deleteWorkspaceItem(path: "data/avatar/avatar-image.png")
            _ = await workspaceClient.deleteWorkspaceItem(path: "data/avatar/character-traits.json")
        }
    }

    // MARK: - Avatar Components Persistence

    private struct AvatarComponents: Codable {
        let bodyShape: String
        let eyeStyle: String
        let color: String
    }

    /// Persists character traits to the assistant's workspace via the gateway.
    private func saveAvatarComponentsViaGateway() {
        guard let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor else {
            Task {
                let workspaceClient = WorkspaceClient()
                _ = await workspaceClient.deleteWorkspaceItem(path: "data/avatar/character-traits.json")
            }
            return
        }
        let components = AvatarComponents(bodyShape: body.rawValue, eyeStyle: eyes.rawValue, color: color.rawValue)
        guard let data = try? JSONEncoder().encode(components) else { return }
        Task {
            let workspaceClient = WorkspaceClient()
            _ = await workspaceClient.writeWorkspaceFile(path: "data/avatar/character-traits.json", content: data)
        }
    }

    // MARK: - Dock Icon

    /// Posted whenever the avatar changes so other components (e.g. menu bar icon) can update.
    static let avatarDidChangeNotification = Notification.Name("AvatarAppearanceManager.avatarDidChange")

    /// The original bundle icon resolved from the `.app` bundle on disk.
    /// Uses `NSWorkspace` so the result is independent of whatever
    /// `applicationIconImage` is set at runtime and already includes all
    /// system-resolved representations.
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsworkspace/icon(forfile:)
    private static let bundledAppIcon: NSImage = {
        NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    }()

    /// Restores the dock icon to the default Vellum logo.
    ///
    /// Per Apple docs, setting `applicationIconImage` to `nil` should
    /// restore the bundle icon, but this is unreliable after activation-
    /// policy transitions (`.accessory` ↔ `.regular`) — macOS can show a
    /// generic blank squircle instead.  Setting the bundle icon explicitly
    /// avoids the issue.
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage
    func restoreBundleIcon() {
        NSApplication.shared.applicationIconImage = Self.bundledAppIcon
        NSApp.dockTile.display()
    }

    /// Updates the application dock icon to match the current avatar.
    /// Uses the custom avatar PNG when available, falls back to a character
    /// avatar rendered from saved traits, then restores the bundled Vellum logo.
    private func updateDockIcon() {
        NotificationCenter.default.post(name: Self.avatarDidChangeNotification, object: nil)

        // Prefer custom avatar PNG, then character avatar from saved traits.
        let avatar: NSImage
        if let custom = customAvatarImage {
            avatar = custom
        } else if let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor {
            avatar = AvatarCompositor.render(bodyShape: body, eyeStyle: eyes, color: color, size: 512)
        } else {
            restoreBundleIcon()
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

    // MARK: - Transparency Resolution

    /// Determines transparency using domain knowledge when possible,
    /// falling back to pixel inspection only for custom uploads.
    private func resolveTransparency(for image: NSImage) -> Bool {
        // Character avatars are always transparent — the compositor draws
        // shapes on a clear NSImage canvas with no background fill.
        if characterBodyShape != nil, characterEyeStyle != nil, characterColor != nil {
            return true
        }
        // Custom uploads need actual pixel inspection.
        if customAvatarImage != nil {
            return VAvatarImage.imageHasTransparency(image)
        }
        // Bundled logo and initial-letter avatars are always opaque
        // (filled circle or opaque PNG).
        return false
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
