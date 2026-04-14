import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SoundManager")

/// Supported audio file extensions for custom sounds.
private let supportedSoundExtensions: Set<String> = ["aiff", "wav", "mp3", "m4a", "caf"]

/// Manages sound playback for configurable app events. Configuration is persisted
/// to `data/sounds/config.json` in the assistant's workspace and accessed via the
/// gateway API so it works identically for all assistants.
@MainActor @Observable
final class SoundManager {
    static let shared = SoundManager()

    /// Current sound configuration, fetched from the gateway.
    private(set) var config: SoundsConfig = .defaultConfig

    /// Cached feature flag store used to check the "sounds" flag without disk I/O.
    /// Set via `start(featureFlagStore:)` so `play(_:)` reads from memory instead
    /// of calling `AssistantFeatureFlagResolver.isEnabled()` (which performs
    /// synchronous file reads on the main thread).
    @ObservationIgnored private var featureFlagStore: AssistantFeatureFlagStore?

    /// Cache of loaded NSSound instances keyed by filename to avoid repeated gateway fetches.
    @ObservationIgnored private var soundCache: [String: NSSound] = [:]

    /// Cached list of available sound files in the workspace sounds directory.
    /// NOT marked `@ObservationIgnored` so SwiftUI re-renders when the async
    /// fetch completes (the Settings dropdown reads this via `availableSounds()`).
    private var cachedAvailableSounds: [(label: String, filename: String)] = []

    /// Guards against re-entrant `refreshAvailableSounds()` calls. Without this,
    /// each SwiftUI render of the sounds tab calls `availableSounds()` which
    /// triggers a fetch when empty, the fetch sets `cachedAvailableSounds`
    /// (even to `[]`), which triggers another render, creating an infinite loop
    /// that hammers the workspace/tree API with 429s.
    @ObservationIgnored private var isRefreshingAvailableSounds = false

    /// Timestamp of the most recent `saveConfig(_:)` call. The daemon watches
    /// `data/sounds/` and broadcasts `soundsConfigUpdated` after any write,
    /// including our own — refetching while writes are still in flight can
    /// read a truncated payload and clobber local state with `.defaultConfig`.
    /// `handleSoundsConfigBroadcast()` uses this to drop self-echo broadcasts.
    @ObservationIgnored private var lastLocalSaveAt: Date?

    /// Window during which an inbound `soundsConfigUpdated` broadcast is
    /// treated as an echo of a recent local save and skipped. Covers the
    /// daemon's 200 ms watcher debounce plus broadcast delivery, with
    /// headroom.
    private static let echoSuppressionWindow: TimeInterval = 2.0

    // MARK: - Lifecycle

    func start(featureFlagStore: AssistantFeatureFlagStore? = nil) {
        self.featureFlagStore = featureFlagStore

        // Reload sounds config on every daemon (re)connect. The daemon
        // only broadcasts sounds_config_updated on file mutations, so
        // without this hook the config would stay at `.defaultConfig`
        // (silent) across every app restart until the user touched
        // data/sounds/config.json on disk. GatewayConnectionManager
        // posts .daemonDidReconnect when `isConnected` transitions to
        // true, giving us the "gateway is confirmed ready" signal.
        //
        // Also kick off one eager reload for the race where the
        // connection already completed before start() runs; if it
        // fails, fetchConfig() silently falls back to defaults and
        // the next .daemonDidReconnect will overwrite them.
        NotificationCenter.default.addObserver(
            forName: .daemonDidReconnect,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.reloadConfig()
            }
        }
        reloadConfig()
    }

    // MARK: - Config Loading & Saving

    /// Fetches and decodes config.json from the assistant's workspace via the
    /// gateway. Falls back to `SoundsConfig.defaultConfig` if the file doesn't
    /// exist or is malformed.
    private func fetchConfig() async {
        do {
            let data = try await WorkspaceClient().fetchWorkspaceFileContent(
                path: "data/sounds/config.json", showHidden: false
            )
            guard !data.isEmpty else {
                config = .defaultConfig
                return
            }
            let decoded = try JSONDecoder().decode(SoundsConfig.self, from: data)
            config = decoded
        } catch {
            log.warning("Failed to fetch sounds config via gateway, using defaults: \(error.localizedDescription)")
            config = .defaultConfig
        }
    }

    /// Re-fetches the sound config and available sounds from the gateway.
    /// Called after reconnection or assistant switches so the UI reflects the
    /// current workspace state without requiring file watchers.
    func reloadConfig() {
        clearCache()
        Task {
            await fetchConfig()
            await refreshAvailableSounds()
        }
    }

    /// Handles a `soundsConfigUpdated` broadcast from the daemon. Drops
    /// broadcasts that fall within the echo-suppression window of a recent
    /// local save — those are the daemon echoing our own write, and
    /// refetching would race against in-flight writes and briefly overwrite
    /// the UI with `.defaultConfig` (globalEnabled=false, empty pools).
    func handleSoundsConfigBroadcast() {
        if let last = lastLocalSaveAt,
           Date().timeIntervalSince(last) < Self.echoSuppressionWindow {
            return
        }
        reloadConfig()
    }

    /// Encodes and writes the config to the assistant's workspace via the gateway.
    /// Called by the Settings UI when the user changes settings.
    func saveConfig(_ newConfig: SoundsConfig) {
        config = newConfig
        lastLocalSaveAt = Date()

        Task {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard let data = try? encoder.encode(newConfig) else {
                log.error("Failed to encode sounds config")
                return
            }
            let client = WorkspaceClient()
            _ = await client.createWorkspaceDirectory(path: "data/sounds")
            let success = await client.writeWorkspaceFile(path: "data/sounds/config.json", content: data)
            if !success {
                log.error("Failed to save sounds config via gateway")
            }
        }
    }

    // MARK: - Sound Resolution

    /// Validates a custom sound filename (extension check + path traversal guard).
    /// Returns `false` if the filename has an unsupported extension or attempts
    /// path traversal outside the sounds directory.
    private func validateSoundFilename(_ filename: String) -> Bool {
        let ext = (filename as NSString).pathExtension.lowercased()
        guard supportedSoundExtensions.contains(ext) else {
            log.warning("Unsupported sound file extension '\(ext)' for '\(filename)', rejecting")
            return false
        }

        // Guard against path traversal: ensure the filename doesn't escape the sounds directory.
        let normalized = (filename as NSString).standardizingPath
        guard !normalized.contains("..") && !normalized.hasPrefix("/") else {
            log.warning("Sound filename '\(filename)' attempts path traversal, ignoring")
            return false
        }

        return true
    }

    /// Picks a random filename from the pool after filtering out entries that
    /// fail `validateSoundFilename`. Returns `nil` when the pool is empty or
    /// every entry is invalid. Single source of truth for pool selection in
    /// `play(_:)`.
    internal func pickSoundFilename(from sounds: [String]) -> String? {
        let validated = sounds.filter { validateSoundFilename($0) }
        return validated.randomElement()
    }

    /// Fetches a custom sound file from the assistant's workspace via the gateway
    /// and returns an `NSSound` instance. Returns `nil` on failure.
    private func fetchCustomSound(filename: String) async -> NSSound? {
        do {
            let data = try await WorkspaceClient().fetchWorkspaceFileContent(
                path: "data/sounds/\(filename)", showHidden: false
            )
            guard !data.isEmpty else { return nil }
            return NSSound(data: data)
        } catch {
            log.warning("Failed to fetch sound file '\(filename)' via gateway: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Playback

    /// Plays the sound associated with the given event, respecting global and per-event toggles.
    func play(_ event: SoundEvent) {
        // Use the cached store when available (zero disk I/O); fall back to
        // the static resolver only if start() was called without a store.
        let soundsEnabled = featureFlagStore?.isEnabled("sounds")
            ?? AssistantFeatureFlagResolver.isEnabled("sounds")
        guard soundsEnabled else { return }
        guard config.globalEnabled else { return }

        let eventConfig = config.config(for: event)
        guard eventConfig.enabled else { return }

        guard let filename = pickSoundFilename(from: eventConfig.sounds) else {
            // Empty pool or every entry failed validation — use default blip.
            playDefault()
            return
        }

        // Use cached sound if available.
        if let cached = soundCache[filename] {
            cached.volume = config.volume
            cached.play()
            return
        }

        // Fetch asynchronously; fall back to default blip for this invocation.
        // The fetched sound will be cached for subsequent plays.
        Task {
            if let sound = await fetchCustomSound(filename: filename) {
                soundCache[filename] = sound
                sound.volume = config.volume
                sound.play()
            } else {
                log.warning("Failed to load sound file '\(filename)', falling back to default")
                playDefault()
            }
        }
    }

    /// Plays the default blip at the current volume.
    private func playDefault() {
        let sound = defaultBlipSound()
        sound.volume = config.volume
        sound.play()
    }

    /// Preview a specific sound by filename at the current volume, bypassing
    /// enabled checks. Fetches from the gateway if not cached. Falls back to
    /// the default blip if the filename is invalid or cannot be fetched. Used
    /// by the Settings sound pool UI so each pool entry can be auditioned.
    func previewSound(filename: String) {
        guard validateSoundFilename(filename) else {
            previewDefaultBlip()
            return
        }

        if let cached = soundCache[filename] {
            cached.volume = config.volume
            cached.play()
            return
        }

        Task {
            if let sound = await fetchCustomSound(filename: filename) {
                soundCache[filename] = sound
                sound.volume = config.volume
                sound.play()
            } else {
                previewDefaultBlip()
            }
        }
    }

    /// Preview the default blip at the current volume, bypassing enabled checks.
    func previewDefaultBlip() {
        let blip = NSSound(named: "Tink") ?? NSSound()
        blip.volume = config.volume
        blip.play()
    }

    /// Returns the default blip sound (macOS system sound "Tink").
    private func defaultBlipSound() -> NSSound {
        if let cached = soundCache["__default_blip__"] {
            return cached
        }

        let blip = NSSound(named: "Tink") ?? NSSound()
        soundCache["__default_blip__"] = blip
        return blip
    }

    // MARK: - Cache

    /// Resets the sound cache, forcing sounds to be re-fetched from the gateway on next play.
    func clearCache() {
        soundCache.removeAll()
        cachedAvailableSounds = []
        isRefreshingAvailableSounds = false
    }

    // MARK: - Available Sounds

    /// Returns the cached list of available sound files. The list is populated
    /// asynchronously via `refreshAvailableSounds()` during `reloadConfig()`.
    /// This powers the Settings UI dropdown for sound selection.
    func availableSounds() -> [(label: String, filename: String)] {
        if cachedAvailableSounds.isEmpty && !isRefreshingAvailableSounds {
            isRefreshingAvailableSounds = true
            Task { await refreshAvailableSounds() }
        }
        return cachedAvailableSounds
    }

    /// Fetches the list of audio files from the sounds directory via the gateway
    /// workspace tree API and updates the cached list.
    private func refreshAvailableSounds() async {
        guard let tree = await WorkspaceClient().fetchWorkspaceTree(path: "data/sounds", showHidden: false) else {
            cachedAvailableSounds = []
            return
        }

        let sounds = tree.entries.compactMap { entry -> (label: String, filename: String)? in
            guard !entry.isDirectory else { return nil }
            let filename = entry.name
            let ext = (filename as NSString).pathExtension.lowercased()
            guard supportedSoundExtensions.contains(ext) else { return nil }
            // Exclude config.json from the sound file list.
            guard filename != "config.json" else { return nil }
            let label = (filename as NSString).deletingPathExtension
            return (label: label, filename: filename)
        }
        .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }

        cachedAvailableSounds = sounds
    }
}
