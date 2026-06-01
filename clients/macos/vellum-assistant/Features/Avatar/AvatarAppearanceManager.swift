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

    /// Authoritative render state returned by `GET /avatar/state`. `kind`
    /// selects the render mode; `traits` is populated for `character`, and the
    /// PNG bytes for `image` are fetched separately from the workspace.
    struct AvatarState: Codable, Equatable {
        enum Kind: String, Codable {
            case character
            case image
            case none
        }

        struct Traits: Codable, Equatable {
            let bodyShape: String
            let eyeStyle: String
            let color: String
        }

        struct ImageInfo: Codable, Equatable {
            let updatedAt: String
            let etag: String
        }

        let kind: Kind
        let traits: Traits?
        let source: String?
        let image: ImageInfo?
    }

    /// The action implied by an `avatar/state` HTTP response, before any state
    /// is mutated. Extracted as a pure function so the transient-vs-authoritative
    /// policy can be unit-tested without a live gateway connection.
    enum StateFetchAction: Equatable {
        /// Apply the decoded authoritative state.
        case apply(AvatarState)
        /// Authoritative "no avatar" (404, or 2xx with empty/garbled body):
        /// clear cached state.
        case clear
        /// Transient failure (401/403/5xx): preserve cached state and retry.
        case retry
    }

    /// Classifies an `avatar/state` response into an action. Pure and
    /// synchronous so the preserve-vs-clear policy is fully testable.
    static func stateFetchAction(statusCode: Int, data: Data) -> StateFetchAction {
        if (200..<300).contains(statusCode) {
            guard !data.isEmpty,
                  let state = try? JSONDecoder().decode(AvatarState.self, from: data) else {
                // A 2xx with an empty/garbled body is treated as an
                // authoritative "no avatar" signal, matching the daemon's
                // `{ kind: "none" }` contract.
                return .clear
            }
            return .apply(state)
        }
        if isAuthoritativeAbsence(statusCode: statusCode) {
            return .clear
        }
        return .retry
    }

    /// Fetches the authoritative avatar render state via `GET /avatar/state`
    /// and applies it in a single pass. On transient failure (401, 5xx,
    /// transport error) the existing cached avatar is preserved and one retry
    /// is scheduled; only an authoritative 404 — or an authoritative `none`
    /// state — clears it. Guarded by `stateRetryInFlight` so repeated transient
    /// failures don't stack retries.
    private func fetchAvatarStateViaHTTP() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "avatar/state",
                timeout: 10
            )
            // Short-circuit state mutations if the task was cancelled while
            // the HTTP request was in flight — otherwise a late-arriving
            // response from the previous assistant can stale-flash the
            // avatar after resetForDisconnect() has cleared state.
            guard !Task.isCancelled else { return }
            switch Self.stateFetchAction(statusCode: response.statusCode, data: response.data) {
            case .apply(let state):
                await applyAvatarState(state)
            case .clear:
                applyNoneState()
            case .retry:
                log.warning("Transient avatar/state fetch failure (HTTP \(response.statusCode)) — preserving cached avatar and scheduling retry")
                scheduleStateRetry()
            }
        } catch {
            guard !Task.isCancelled else { return }
            log.warning("Transport failure fetching avatar/state — preserving cached avatar and scheduling retry: \(error.localizedDescription)")
            scheduleStateRetry()
        }
    }

    /// Applies a decoded `AvatarState` by switching on `kind`:
    /// - `character`: render the animated character from traits, clear any image.
    /// - `image`: fetch the PNG bytes and use the static custom-image path.
    /// - `none`: clear both → default character / fallback.
    private func applyAvatarState(_ state: AvatarState) async {
        switch state.kind {
        case .character:
            applyCharacterState(state.traits)
        case .image:
            await applyImageState()
        case .none:
            applyNoneState()
        }
    }

    /// Sets character traits from the authoritative state and clears the custom
    /// image so the animated `AnimatedAvatarView` path is used.
    func applyCharacterState(_ traits: AvatarState.Traits?) {
        guard let traits,
              let body = AvatarBodyShape(rawValue: traits.bodyShape),
              let eyes = AvatarEyeStyle(rawValue: traits.eyeStyle),
              let color = AvatarColor(rawValue: traits.color) else {
            // Malformed traits for a "character" state: treat as no usable
            // avatar rather than overwriting good cached state.
            return
        }
        characterBodyShape = body
        characterEyeStyle = eyes
        characterColor = color
        customAvatarImage = nil
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        AvatarCache.saveTraits(bodyShape: body, eyeStyle: eyes, color: color)
        AvatarCache.clearImage()
        updateDockIcon()
    }

    /// Fetches the avatar PNG bytes from the workspace and uses them as the
    /// custom (static) image, clearing character traits so the static
    /// `VAvatarImage` path is used. A transient PNG fetch failure preserves the
    /// existing cached image and schedules a retry of the whole state fetch.
    private func applyImageState() async {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "workspace/file/content",
                params: ["path": "data/avatar/avatar-image.png"],
                timeout: 10
            )
            guard !Task.isCancelled else { return }
            if response.isSuccess, !response.data.isEmpty {
                customAvatarImage = NSImage(data: response.data)
                characterBodyShape = nil
                characterEyeStyle = nil
                characterColor = nil
                cachedChatAvatar = nil
                AvatarCache.saveImage(response.data)
                AvatarCache.clearTraits()
                updateDockIcon()
                return
            }
            if Self.isAuthoritativeAbsence(statusCode: response.statusCode) {
                applyNoneState()
                return
            }
            log.warning("Transient avatar image fetch failure (HTTP \(response.statusCode)) — preserving cached image and scheduling retry")
            scheduleStateRetry()
        } catch {
            guard !Task.isCancelled else { return }
            log.warning("Transport failure fetching avatar image — preserving cached image and scheduling retry: \(error.localizedDescription)")
            scheduleStateRetry()
        }
    }

    /// Clears both the custom image and character traits so the default
    /// character / bundled-logo / initial-letter fallback is used. Called for an
    /// authoritative `none` state or 404.
    func applyNoneState() {
        if customAvatarImage != nil { customAvatarImage = nil }
        if characterBodyShape != nil { characterBodyShape = nil }
        if characterEyeStyle != nil { characterEyeStyle = nil }
        if characterColor != nil { characterColor = nil }
        cachedChatAvatar = nil
        cachedFallbackAvatar = nil
        cachedFullFallbackAvatar = nil
        AvatarCache.clearAll()
        updateDockIcon()
    }

    /// Guards against stacking overlapping retries when repeated transient
    /// failures arrive before the first retry has completed. Tracked as a Task
    /// handle so `resetForDisconnect()` can cancel a pending retry before it
    /// writes into the next assistant's state.
    @ObservationIgnored private var stateRetryInFlight = false
    @ObservationIgnored private var stateRetryTask: Task<Void, Never>?
    /// Tracks the primary (non-retry) fetch Task spawned by `reloadAvatar()` so
    /// `resetForDisconnect()` can cancel a fetch in flight. Without cancellation,
    /// a late-arriving response from the previous assistant would bypass the
    /// `Task.isCancelled` guards in the fetch methods and stale-flash state.
    @ObservationIgnored private var avatarPrimaryTask: Task<Void, Never>?

    private func scheduleStateRetry() {
        guard !stateRetryInFlight else { return }
        stateRetryInFlight = true
        stateRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.transientRetryDelayNs)
            guard !Task.isCancelled, let self else { return }
            await self.fetchAvatarStateViaHTTP()
            guard !Task.isCancelled else { return }
            self.stateRetryInFlight = false
            self.stateRetryTask = nil
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

        // Character traits are small JSON — persist synchronously.
        if isCharacter, let body = bodyShape, let eyes = eyeStyle, let color = color {
            AvatarCache.saveTraits(bodyShape: body, eyeStyle: eyes, color: color)
            AvatarCache.clearImage()
        }

        // Character traits don't need a PNG re-encode for the daemon — the
        // daemon renders the PNG itself from the traits. Persist them through
        // the manifest-aware `render-from-traits` endpoint so `avatar.json`
        // stays authoritative.
        if isCharacter {
            if !skipWorkspaceSync, let body = bodyShape, let eyes = eyeStyle, let color = color {
                Task { [weak self] in
                    await self?.syncTraitsToDaemon(bodyShape: body, eyeStyle: eyes, color: color)
                }
            }
            return
        }

        // Custom upload: PNG encoding (tiffRepresentation → NSBitmapImageRep →
        // .png) is CPU-bound. Run off-main so it doesn't block the UI while the
        // image is persisted to the local cache and uploaded to the daemon.
        let syncToWorkspace = !skipWorkspaceSync
        Task.detached(priority: .utility) { [weak self] in
            guard let tiffData = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiffData),
                  let pngData = bitmap.representation(using: .png, properties: [:]) else { return }

            AvatarCache.saveImage(pngData)
            AvatarCache.clearTraits()

            guard syncToWorkspace else { return }

            // Route through the manifest-aware `avatar/image` endpoint: the
            // daemon writes the PNG, clears any character traits, and updates
            // `avatar.json` atomically. Replaces the prior direct
            // `workspace/write` of avatar-image.png + `workspace/delete` of
            // character-traits.json, which left the manifest stale. Base64 is
            // encoded here (off-main) so only the HTTP call hops to the actor.
            let base64 = pngData.base64EncodedString()
            await self?.uploadCustomImageToDaemon(base64: base64)
        }
    }

    /// Uploads a base64-encoded custom-image PNG to the daemon via the
    /// manifest-aware `avatar/image` endpoint. The daemon writes the PNG,
    /// clears character traits, and records an `image` manifest.
    private func uploadCustomImageToDaemon(base64: String) async {
        await postAvatarMutation(
            label: "uploadCustomImageToDaemon",
            path: "avatar/image",
            json: ["content": base64, "encoding": "base64"],
            timeout: 30
        )
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
            await self?.fetchAvatarStateViaHTTP()
        }
    }

    /// Posts character traits to the daemon via the gateway so the daemon
    /// renders and persists the avatar in its workspace. Used after onboarding
    /// to sync the randomly-generated avatar to the daemon (especially
    /// important for managed/remote assistants where the filesystem is not shared).
    /// Fires `reloadAvatar()` on success so cached state picks up the daemon's
    /// rendered image.
    func syncTraitsToDaemon(bodyShape: AvatarBodyShape, eyeStyle: AvatarEyeStyle, color: AvatarColor) async {
        log.info("[avatarSync] syncTraitsToDaemon: posting \(bodyShape.rawValue)/\(eyeStyle.rawValue)/\(color.rawValue)")
        await postAvatarMutation(
            label: "syncTraitsToDaemon",
            path: "avatar/render-from-traits",
            json: [
                "bodyShape": bodyShape.rawValue,
                "eyeStyle": eyeStyle.rawValue,
                "color": color.rawValue,
            ],
            // Pick up the daemon's rendered image so cached state matches the
            // authoritative render. The image/remove paths instead rely on the
            // daemon's `avatar_changed` event to trigger a reload.
            onSuccess: { [weak self] in self?.reloadAvatar() }
        )
    }

    /// Posts a manifest-aware avatar mutation to the daemon, retrying up to 3
    /// times with an incremental delay on transient 5xx / transport failures
    /// (e.g. a freshly-hatched assistant that isn't fully ready). The daemon
    /// owns the workspace write and `avatar.json` update; this is the single
    /// retry/log policy shared by the traits, image-upload, and remove paths.
    private func postAvatarMutation(
        label: String,
        path: String,
        json: [String: Any],
        timeout: TimeInterval = 15,
        onSuccess: (() -> Void)? = nil
    ) async {
        for attempt in 1...3 {
            do {
                let response = try await GatewayHTTPClient.post(path: path, json: json, timeout: timeout)
                if response.isSuccess {
                    onSuccess?()
                    return
                } else if response.statusCode >= 500 && attempt < 3 {
                    log.warning("[avatarSync] \(label): HTTP \(response.statusCode) on attempt \(attempt), retrying...")
                    try await Task.sleep(nanoseconds: UInt64(attempt) * 1_000_000_000)
                } else {
                    log.warning("[avatarSync] \(label): HTTP \(response.statusCode) on attempt \(attempt), giving up")
                    return
                }
            } catch {
                log.warning("[avatarSync] \(label): error on attempt \(attempt): \(error.localizedDescription)")
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
        // Cancel any pending retry Task and clear the in-flight flag so a retry
        // spawned against the previous assistant cannot fire after state has
        // been cleared, and so the next connection's legitimate retries are
        // not silently no-oped by a stale in-flight flag.
        stateRetryTask?.cancel()
        stateRetryTask = nil
        stateRetryInFlight = false
        // Cancel the in-flight primary fetch too; the `Task.isCancelled` guards
        // inside `fetchAvatarStateViaHTTP` suppress the state mutation once the
        // surrounding Task is cancelled.
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
        // Explicit reset: drop the persisted dock label so the next build
        // falls back to the env-default ("Vellum"/"Vellum Dev"). `updateDockLabel`
        // intentionally no-ops on the "V" sentinel to avoid clobbering during
        // the cold-start gateway race, so we delete here instead.
        try? FileManager.default.removeItem(at: Self.dockDisplayNameURL)
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

        // Clear the avatar on the daemon via the manifest-aware `avatar/remove`
        // endpoint: it deletes all artifacts (image + traits) and records a
        // `kind:"none"` manifest atomically. Replaces the prior direct
        // `workspace/delete` calls, which left `avatar.json` stale.
        Task { [weak self] in
            await self?.removeAvatarOnDaemon()
        }
    }

    /// Clears the avatar on the daemon via the manifest-aware `avatar/remove`
    /// endpoint.
    private func removeAvatarOnDaemon() async {
        await postAvatarMutation(
            label: "removeAvatarOnDaemon",
            path: "avatar/remove",
            json: [:]
        )
    }

    // MARK: - Dock Icon

    /// Posted whenever the avatar changes so other components (e.g. menu bar icon) can update.
    static let avatarDidChangeNotification = Notification.Name("AvatarAppearanceManager.avatarDidChange")

    /// Monotonically increasing generation counter for dock icon updates.
    /// Prevents a slow background rasterization from overwriting a newer
    /// icon when multiple `updateDockIcon()` calls overlap.
    @ObservationIgnored private var dockIconGeneration: Int = 0

    /// The original bundle icon resolved from the `.app` bundle on disk.
    /// Uses `NSWorkspace` so the result is independent of whatever
    /// `applicationIconImage` is set at runtime and already includes all
    /// system-resolved representations.
    ///
    /// Loaded directly from `AppIcon.icns` rather than via
    /// `NSWorkspace.icon(forFile: bundlePath)` because `updateDockIcon()`
    /// writes a custom Finder icon (`Icon\r`) onto the `.app` bundle to
    /// override the notification daemon's icon. That custom file persists
    /// across launches, so reading the bundle's Finder icon would capture
    /// the stale avatar from a previous session and cause `restoreBundleIcon()`
    /// to "restore" it instead of the real Vellum logo. Reading the `.icns`
    /// resource bypasses Finder metadata entirely.
    ///
    /// Marked `nonisolated` so the background prefetch in `start()` can
    /// trigger the lazy initializer off the main thread without crossing
    /// the enclosing `@MainActor` boundary.
    private nonisolated static let bundledAppIcon: NSImage = {
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        return NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
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
        dockIconGeneration += 1
        let generation = dockIconGeneration
        NSApplication.shared.applicationIconImage = Self.bundledAppIcon
        NSApp.dockTile.display()
        let bundlePath = Bundle.main.bundlePath
        Task.detached(priority: .utility) { [weak self] in
            let isCurrent = await MainActor.run { [weak self] in
                self?.dockIconGeneration == generation
            }
            guard isCurrent else { return }
            NSWorkspace.shared.setIcon(nil, forFile: bundlePath, options: [])
        }
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
    ///
    /// Image processing (resize, squircle mask, compositing, rasterization)
    /// and the `NSWorkspace.setIcon` write (which internally encodes PNG at
    /// every icon size) run in a detached task so the main thread is never
    /// blocked. A monotonic generation counter ensures that only the most
    /// recent invocation's result is applied to the dock tile.
    ///
    /// Reference: https://developer.apple.com/documentation/appkit/nsimage
    /// — "You may create, use, and destroy NSImage objects from any thread."
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

        dockIconGeneration += 1
        let generation = dockIconGeneration
        let bundlePath = Bundle.main.bundlePath

        Task.detached(priority: .userInitiated) { [weak self] in
            let icon = Self.composeDockIcon(from: avatar)

            // Check generation before the expensive disk write so a
            // superseded task doesn't overwrite a newer icon's .icns.
            let isCurrent = await MainActor.run { [weak self] in
                self?.dockIconGeneration == generation
            }
            guard isCurrent else { return }

            // Write .icns to disk — the heaviest single operation (PNG
            // encoding at multiple resolutions). Safe off main thread:
            // NSWorkspace.setIcon writes to the file system.
            NSWorkspace.shared.setIcon(icon, forFile: bundlePath, options: [])

            await MainActor.run { [weak self] in
                guard let self, self.dockIconGeneration == generation else { return }
                NSApplication.shared.applicationIconImage = icon
                NSApp.dockTile.display()
            }
        }
    }

    /// Composes the padded squircle dock icon from a source avatar and forces
    /// rasterization so the result is a flat bitmap with no deferred drawing
    /// handlers. Callers receive an image that can be displayed or encoded
    /// without triggering further computation.
    nonisolated private static func composeDockIcon(from avatar: NSImage) -> NSImage {
        // Standard macOS icons have ~10% padding so the artwork doesn't crowd
        // the dock running-indicator dot or produce edge fringe artifacts.
        let canvasSize: CGFloat = 512
        let iconSize: CGFloat = 418  // ~82% of canvas, matching Apple icon grid
        let padding = (canvasSize - iconSize) / 2
        let squircle = squircleIcon(avatar, size: iconSize)

        let composed = NSImage(size: NSSize(width: canvasSize, height: canvasSize), flipped: false) { _ in
            let iconRect = NSRect(x: padding, y: padding, width: iconSize, height: iconSize)
            squircle.draw(in: iconRect, from: NSRect(origin: .zero, size: squircle.size),
                          operation: .copy, fraction: 1.0)
            return true
        }

        // Force rasterization: tiffRepresentation executes all deferred
        // drawing handlers (resize → squircle mask → compositing) and
        // produces a bitmap. Re-creating from that data gives an NSImage
        // backed by NSBitmapImageRep, so dockTile.display() on the main
        // thread just blits pixels instead of running the full pipeline.
        guard let tiffData = composed.tiffRepresentation,
              let rasterized = NSImage(data: tiffData) else {
            return composed
        }
        return rasterized
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
        // Only persist a resolved persona name. Writing a "Vellum" fallback
        // here would clobber a previously-good value during the gateway
        // cold-start race window — `IdentityInfo.loadAsync()` is a gateway
        // HTTP call, and when the daemon/gateway aren't up yet it returns
        // nil and `assistantName` collapses to "V". Overwriting at that
        // point causes the next rebuild's `build.sh` to read "Vellum" and
        // produce `Vellum.app` alongside the existing persona-named bundle.
        // `cli/src/commands/retire.ts` deletes this file when the last
        // assistant is retired, so no default write is needed either.
        guard assistantName != "V" else { return }

        let dir = Self.dockDisplayNameURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? assistantName.write(to: Self.dockDisplayNameURL, atomically: true, encoding: .utf8)
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
