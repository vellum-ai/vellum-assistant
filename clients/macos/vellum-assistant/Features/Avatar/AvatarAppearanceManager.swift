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

    /// The assistant's display name, loaded once from IDENTITY.md to avoid repeated disk I/O.
    private var assistantName: String = "V"
    /// Tracked identity-load task so resetForDisconnect can cancel in-flight loads.
    @ObservationIgnored private var identityLoadTask: Task<Void, Never>?

    func start() {
        // Warm `bundledAppIcon` off the main thread so a later main-thread
        // read in `restoreBundleIcon()` (resetForDisconnect, clearCustomAvatar,
        // or 404 fall-through in updateDockIcon) doesn't pay the
        // NSWorkspace.icon(forFile:) cost on the main thread.
        Task.detached { _ = Self.bundledAppIcon }

        identityLoadTask = Task {
            let info = await IdentityInfo.loadAsync()
            guard !Task.isCancelled else { return }
            assistantName = AssistantDisplayName.resolve(info?.name, fallback: "V")
            updateDockLabel()
        }

        // Hydrate the dock icon from the local cache synchronously so the
        // avatar appears immediately on launch, before the daemon is ready.
        // `reloadAvatar()` later refreshes against the authoritative state
        // via the gateway and overwrites the cache if anything changed.
        hydrateFromCache()

        // Remote avatar/trait fetches are deferred to reloadAvatar() once
        // the gateway is confirmed ready. Fetching here would race daemon
        // startup and clear the avatar on connection-refused; the local
        // cache covers the cold-start window until that retry succeeds.

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

    /// Delay before retrying an avatar fetch that failed with a transient error.
    /// Long enough for in-flight token refresh to complete, short enough that the
    /// user sees the right avatar before the UI settles.
    private static let transientRetryDelayNs: UInt64 = 2_000_000_000 // 2s

    /// Whether a non-success response represents an authoritative "no avatar
    /// exists" signal (404) as opposed to a transient failure (401, 5xx,
    /// transport/network error). Authoritative absence clears cached state;
    /// transient failures preserve it so a brief auth-race during bootstrap
    /// does not replace a previously-good avatar with the bundled fallback.
    static func isAuthoritativeAbsence(statusCode: Int) -> Bool {
        return statusCode == 404
    }

    /// Fetches the avatar image via HTTP through the gateway. On transient
    /// failure (401, 5xx, transport error) the existing cached image is
    /// preserved and one retry is scheduled; only an authoritative 404 clears
    /// it. Guarded by `avatarRetryInFlight` so repeated transient failures
    /// don't stack retries.
    private func fetchAvatarViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "workspace/file/content",
                params: ["path": "data/avatar/avatar-image.png"],
                timeout: 10
            )
            // Short-circuit state mutations if the task was cancelled while
            // the HTTP request was in flight — otherwise a late-arriving
            // response from the previous assistant can stale-flash the
            // avatar after resetForDisconnect() has cleared state.
            guard !Task.isCancelled else { return }
            if response.isSuccess, !response.data.isEmpty {
                cachedChatAvatar = nil
                customAvatarImage = NSImage(data: response.data)
                AvatarCache.saveImage(response.data)
                updateDockIcon()
                return
            }
            if Self.isAuthoritativeAbsence(statusCode: response.statusCode) {
                if customAvatarImage != nil { customAvatarImage = nil }
                cachedChatAvatar = nil
                AvatarCache.clearImage()
                updateDockIcon()
                return
            }
            log.warning("Transient avatar fetch failure (HTTP \(response.statusCode)) — preserving cached image and scheduling retry")
            scheduleAvatarRetry()
        } catch {
            guard !Task.isCancelled else { return }
            log.warning("Transport failure fetching avatar — preserving cached image and scheduling retry: \(error.localizedDescription)")
            scheduleAvatarRetry()
        }
    }

    /// Fetches character-traits.json via HTTP through the gateway. Same
    /// transient-vs-authoritative policy as the avatar image: 404 clears the
    /// cached traits, 401/5xx/transport errors preserve them and schedule one
    /// retry.
    private func fetchTraitsViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "workspace/file/content",
                params: ["path": "data/avatar/character-traits.json"],
                timeout: 10
            )
            // Short-circuit state mutations if the task was cancelled while
            // the HTTP request was in flight — otherwise a late-arriving
            // response from the previous assistant can stale-flash the
            // traits after resetForDisconnect() has cleared state.
            guard !Task.isCancelled else { return }
            if response.isSuccess, !response.data.isEmpty {
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
                if let body = characterBodyShape, let eyes = characterEyeStyle, let color = characterColor {
                    AvatarCache.saveTraits(bodyShape: body, eyeStyle: eyes, color: color)
                }
                AvatarCache.clearImage()
                updateDockIcon()
                return
            }
            if Self.isAuthoritativeAbsence(statusCode: response.statusCode) {
                if characterBodyShape != nil { characterBodyShape = nil }
                if characterEyeStyle != nil { characterEyeStyle = nil }
                if characterColor != nil { characterColor = nil }
                cachedFallbackAvatar = nil
                cachedFullFallbackAvatar = nil
                AvatarCache.clearTraits()
                updateDockIcon()
                return
            }
            log.warning("Transient traits fetch failure (HTTP \(response.statusCode)) — preserving cached traits and scheduling retry")
            scheduleTraitsRetry()
        } catch {
            guard !Task.isCancelled else { return }
            log.warning("Transport failure fetching character traits — preserving cached traits and scheduling retry: \(error.localizedDescription)")
            scheduleTraitsRetry()
        }
    }

    /// Guards against stacking overlapping retries when repeated transient
    /// failures arrive before the first retry has completed. Tracked as Task
    /// handles so `resetForDisconnect()` can cancel a pending retry before it
    /// writes into the next assistant's state.
    @ObservationIgnored private var avatarRetryInFlight = false
    @ObservationIgnored private var traitsRetryInFlight = false
    @ObservationIgnored private var avatarRetryTask: Task<Void, Never>?
    @ObservationIgnored private var traitsRetryTask: Task<Void, Never>?
    /// Tracks the primary (non-retry) fetch Task spawned by `reloadAvatar()` so
    /// `resetForDisconnect()` can cancel a fetch in flight. Without cancellation,
    /// a late-arriving response from the previous assistant would bypass the
    /// `Task.isCancelled` guards in the fetch methods and stale-flash state.
    @ObservationIgnored private var avatarPrimaryTask: Task<Void, Never>?

    private func scheduleAvatarRetry() {
        guard !avatarRetryInFlight else { return }
        avatarRetryInFlight = true
        avatarRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.transientRetryDelayNs)
            guard !Task.isCancelled, let self else { return }
            await self.fetchAvatarViaHTTP()
            guard !Task.isCancelled else { return }
            self.avatarRetryInFlight = false
            self.avatarRetryTask = nil
        }
    }

    private func scheduleTraitsRetry() {
        guard !traitsRetryInFlight else { return }
        traitsRetryInFlight = true
        traitsRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.transientRetryDelayNs)
            guard !Task.isCancelled, let self else { return }
            await self.fetchTraitsViaHTTP()
            guard !Task.isCancelled else { return }
            self.traitsRetryInFlight = false
            self.traitsRetryTask = nil
        }
    }

    // MARK: - Custom Avatar

    /// Saves the avatar image locally and (by default) persists it to the
    /// assistant's workspace via the gateway.
    ///
    /// - Parameter skipWorkspaceSync: When `true`, only update the in-memory
    ///   state and local cache — skip the gateway workspace write. Used during
    ///   hatch completion where the guardian token hasn't been imported yet;
    ///   the workspace sync will happen later via `syncOnboardingAvatarIfNeeded`
    ///   / `syncTraitsToDaemon` once the daemon connection is authenticated.
    func saveAvatar(_ image: NSImage, bodyShape: AvatarBodyShape? = nil, eyeStyle: AvatarEyeStyle? = nil, color: AvatarColor? = nil, skipWorkspaceSync: Bool = false) {
        let isCharacter = bodyShape != nil

        guard let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let pngData = bitmap.representation(using: .png, properties: [:]) else { return }

        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil

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

        // Update the local client-side cache so the next cold launch can
        // hydrate the dock icon before the daemon is ready.
        if isCharacter, let body = bodyShape, let eyes = eyeStyle, let color = color {
            AvatarCache.saveTraits(bodyShape: body, eyeStyle: eyes, color: color)
            AvatarCache.clearImage()
        } else {
            AvatarCache.saveImage(pngData)
            AvatarCache.clearTraits()
        }

        guard !skipWorkspaceSync else { return }

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

        avatarPrimaryTask?.cancel()
        avatarPrimaryTask = Task { [weak self] in
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
                    path: "avatar/render-from-traits",
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
        // Cancel any pending retry Tasks and clear in-flight flags so a retry
        // spawned against the previous assistant cannot fire after state has
        // been cleared, and so the next connection's legitimate retries are
        // not silently no-oped by a stale in-flight flag.
        avatarRetryTask?.cancel()
        avatarRetryTask = nil
        avatarRetryInFlight = false
        traitsRetryTask?.cancel()
        traitsRetryTask = nil
        traitsRetryInFlight = false
        // Cancel the in-flight primary fetch too; the `Task.isCancelled` guards
        // inside `fetchAvatarViaHTTP`/`fetchTraitsViaHTTP` suppress the state
        // mutation once the surrounding Task is cancelled.
        avatarPrimaryTask?.cancel()
        avatarPrimaryTask = nil
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
        AvatarCache.clearAll()
        updateDockIcon()
        updateDockLabel()
    }

    // MARK: - Local Cache Hydration

    /// Loads any persisted avatar state from the local cache and populates
    /// in-memory properties. Runs synchronously during `start()` so the dock
    /// icon reflects the user's avatar before the daemon is reachable.
    private func hydrateFromCache() {
        let cached = AvatarCache.load()
        if let traits = cached.traits {
            characterBodyShape = traits.bodyShape
            characterEyeStyle = traits.eyeStyle
            characterColor = traits.color
            updateDockIcon()
        } else if let image = cached.image {
            customAvatarImage = image
            updateDockIcon()
        }
    }

    func clearCustomAvatar() {
        customAvatarImage = nil
        characterBodyShape = nil
        characterEyeStyle = nil
        characterColor = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        AvatarCache.clearAll()
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
    /// Marked `nonisolated` to opt this static out of the enclosing
    /// `@MainActor` isolation so the background prefetch in `start()` can
    /// trigger the lazy initializer off the main thread without crossing
    /// an actor boundary. The initializer is safe to run on any thread:
    /// `NSWorkspace.icon(forFile:)` is documented thread-safe, and the
    /// resulting `NSImage` is treated as a single immutable value for the
    /// life of the process.
    ///
    /// References:
    /// - https://developer.apple.com/documentation/appkit/nsworkspace/icon(forfile:)
    /// - https://github.com/swiftlang/swift-evolution/blob/main/proposals/0434-global-actor-isolated-types-usability.md
    private nonisolated static let bundledAppIcon: NSImage = {
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
    /// Also clears any custom Finder icon previously set on the `.app`
    /// bundle so the notification daemon (`usernoted`) reverts to the
    /// bundled green V. `applicationIconImage` only affects the in-process
    /// Dock tile; LaunchServices-resolved surfaces (Finder, notifications)
    /// read from the file-system icon metadata that `setIcon` writes.
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsapplication/applicationiconimage
    func restoreBundleIcon() {
        NSApplication.shared.applicationIconImage = Self.bundledAppIcon
        NSApp.dockTile.display()
        NSWorkspace.shared.setIcon(nil, forFile: Bundle.main.bundlePath, options: [])
    }

    /// Updates the application dock icon to match the current avatar.
    /// Uses the custom avatar PNG when available, falls back to a character
    /// avatar rendered from saved traits, then restores the bundled Vellum logo.
    ///
    /// Mirrors the icon to the `.app` bundle via `NSWorkspace.setIcon` so
    /// LaunchServices-resolved surfaces (Finder, notification daemon) also
    /// pick up the avatar. `applicationIconImage` only affects the
    /// in-process Dock tile, which is why notifications would otherwise
    /// keep showing the bundled green V.
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
        NSWorkspace.shared.setIcon(icon, forFile: Bundle.main.bundlePath, options: [])
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
    ///
    /// Lives under the environment-scoped XDG config directory so that
    /// production and non-production builds don't collide (e.g.
    /// `~/.config/vellum/dock-display-name` for production,
    /// `~/.config/vellum-dev/dock-display-name` for dev).
    private static let dockDisplayNameURL: URL = {
        VellumPaths.current.configDir
            .appendingPathComponent("dock-display-name")
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

// MARK: - Local Avatar Cache

/// On-disk cache of the avatar image and character traits, persisted under
/// Application Support so the dock icon can be hydrated synchronously on cold
/// launch before the daemon is ready. The gateway remains the authoritative
/// source; this is a pure client-side cache that mirrors whatever state has
/// been successfully fetched or saved. Cleared on logout, assistant switch,
/// explicit avatar clear, and authoritative 404 responses.
///
/// Reference: [File System Basics](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html)
/// — Apple recommends `Library/Application Support/` for app-specific data
/// files that should persist across launches but are not directly user-created.
/// `Caches/` would let the OS purge contents, which would defeat the
/// cold-start hydration purpose.
fileprivate enum AvatarCache {
    struct Snapshot {
        var image: NSImage?
        var traits: (bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor)?
    }

    private struct CachedTraits: Codable {
        let bodyShape: String
        let eyeStyle: String
        let color: String
    }

    private static let cacheDir: URL = {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support")
        return base
            .appendingPathComponent(Bundle.appBundleIdentifier, isDirectory: true)
            .appendingPathComponent("AvatarCache", isDirectory: true)
    }()

    private static let imageURL = cacheDir.appendingPathComponent("avatar-image.png")
    private static let traitsURL = cacheDir.appendingPathComponent("character-traits.json")

    static func load() -> Snapshot {
        var snapshot = Snapshot()
        if let data = try? Data(contentsOf: traitsURL),
           let cached = try? JSONDecoder().decode(CachedTraits.self, from: data),
           let body = AvatarBodyShape(rawValue: cached.bodyShape),
           let eyes = AvatarEyeStyle(rawValue: cached.eyeStyle),
           let color = AvatarColor(rawValue: cached.color) {
            snapshot.traits = (body, eyes, color)
        } else if let data = try? Data(contentsOf: imageURL),
                  let image = NSImage(data: data) {
            snapshot.image = image
        }
        return snapshot
    }

    static func saveImage(_ data: Data) {
        ensureDir()
        try? data.write(to: imageURL, options: .atomic)
    }

    static func clearImage() {
        try? FileManager.default.removeItem(at: imageURL)
    }

    static func saveTraits(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor) {
        ensureDir()
        let cached = CachedTraits(
            bodyShape: bodyShape.rawValue,
            eyeStyle: eyeStyle.rawValue,
            color: color.rawValue
        )
        if let data = try? JSONEncoder().encode(cached) {
            try? data.write(to: traitsURL, options: .atomic)
        }
    }

    static func clearTraits() {
        try? FileManager.default.removeItem(at: traitsURL)
    }

    static func clearAll() {
        clearImage()
        clearTraits()
    }

    private static func ensureDir() {
        try? FileManager.default.createDirectory(
            at: cacheDir,
            withIntermediateDirectories: true
        )
    }
}
