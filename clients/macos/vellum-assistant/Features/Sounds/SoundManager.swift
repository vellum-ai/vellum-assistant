import AppKit
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SoundManager")

/// Supported audio file extensions for custom sounds.
private let supportedSoundExtensions: Set<String> = ["aiff", "wav", "mp3", "m4a", "caf"]

/// Manages sound playback for configurable app events. Configuration is persisted
/// to `~/.vellum/workspace/data/sounds/config.json` and watched via FSEvents so
/// external changes (e.g. the assistant writing config) are picked up automatically.
///
/// Follows the same `@MainActor @Observable` singleton + FSEvents file-watcher pattern
/// as `AvatarAppearanceManager`.
@MainActor @Observable
final class SoundManager {
    static let shared = SoundManager()

    /// Current sound configuration, loaded from disk.
    private(set) var config: SoundsConfig = .defaultConfig

    /// Cached feature flag store used to check the "sounds" flag without disk I/O.
    /// Set via `start(featureFlagStore:)` so `play(_:)` reads from memory instead
    /// of calling `AssistantFeatureFlagResolver.isEnabled()` (which performs
    /// synchronous file reads on the main thread).
    @ObservationIgnored private var featureFlagStore: AssistantFeatureFlagStore?

    /// Cache of loaded NSSound instances keyed by filename to avoid repeated disk loads.
    @ObservationIgnored private var soundCache: [String: NSSound] = [:]

    @ObservationIgnored private var fileMonitor: DispatchSourceFileSystemObject?

    // MARK: - Sounds Directory Path

    /// Resolve the sounds directory for the currently connected assistant.
    /// Mirrors the pattern used by `AvatarAppearanceManager.customAvatarURL`.
    private var soundsDirectoryURL: URL {
        if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId"),
           let assistant = LockfileAssistant.loadByName(assistantId),
           let workspace = assistant.workspaceDir {
            return URL(fileURLWithPath: workspace)
                .appendingPathComponent("data/sounds")
        }
        return Self.defaultSoundsDirectoryURL()
    }

    /// Default sounds directory when no connected assistant is resolved.
    nonisolated static func defaultSoundsDirectoryURL(homeDirectory: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: homeDirectory)
            .appendingPathComponent(".vellum/workspace/data/sounds")
    }

    /// URL of the config.json file within the sounds directory.
    private var configFileURL: URL {
        soundsDirectoryURL.appendingPathComponent("config.json")
    }

    // MARK: - Lifecycle

    func start(featureFlagStore: AssistantFeatureFlagStore? = nil) {
        self.featureFlagStore = featureFlagStore
        loadConfig()
        watchConfigFile()
    }

    func stop() {
        fileMonitor?.cancel()
        fileMonitor = nil
    }

    // MARK: - Config Loading & Saving

    /// Reads and decodes config.json from the sounds directory. Falls back to
    /// `SoundsConfig.defaultConfig` if the file doesn't exist or is malformed.
    func loadConfig() {
        let url = configFileURL
        guard FileManager.default.fileExists(atPath: url.path) else {
            config = .defaultConfig
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(SoundsConfig.self, from: data)
            config = decoded
        } catch {
            log.warning("Failed to parse sounds config, using defaults: \(error.localizedDescription)")
            config = .defaultConfig
        }
    }

    /// Encodes and writes the config to disk with pretty-printing.
    /// Called by the Settings UI when the user changes settings.
    func saveConfig(_ newConfig: SoundsConfig) {
        config = newConfig
        let url = configFileURL
        let dir = url.deletingLastPathComponent()

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(newConfig)
            try data.write(to: url, options: .atomic)
        } catch {
            log.error("Failed to save sounds config: \(error.localizedDescription)")
        }
    }

    // MARK: - Sound Resolution

    /// Validates a custom sound filename (extension check + path traversal guard) and returns
    /// the resolved file URL if it passes. Returns `nil` if the filename has an unsupported
    /// extension, attempts path traversal outside the sounds directory, or does not exist on disk.
    private func resolveCustomSoundURL(filename: String) -> URL? {
        // Validate the file extension is supported.
        let ext = (filename as NSString).pathExtension.lowercased()
        guard supportedSoundExtensions.contains(ext) else {
            log.warning("Unsupported sound file extension '\(ext)' for '\(filename)', rejecting")
            return nil
        }

        let fileURL = soundsDirectoryURL.appendingPathComponent(filename)

        // Guard against path traversal: ensure the resolved path stays within the sounds directory.
        let resolvedPath = fileURL.standardizedFileURL.path
        let safeDirPath = soundsDirectoryURL.standardizedFileURL.path
        guard resolvedPath.hasPrefix(safeDirPath + "/") || resolvedPath == safeDirPath else {
            log.warning("Sound filename '\(filename)' resolves outside the sounds directory, ignoring")
            return nil
        }

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            log.warning("Sound file not found at '\(fileURL.path)'")
            return nil
        }

        return fileURL
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

        let sound: NSSound

        if let filename = eventConfig.sound {
            guard let fileURL = resolveCustomSoundURL(filename: filename) else {
                sound = defaultBlipSound()
                sound.volume = config.volume
                sound.play()
                return
            }

            // Use cached sound or load from disk.
            if let cached = soundCache[filename] {
                sound = cached
            } else if let loaded = NSSound(contentsOf: fileURL, byReference: true) {
                soundCache[filename] = loaded
                sound = loaded
            } else {
                log.warning("Failed to load sound file '\(filename)', falling back to default")
                sound = defaultBlipSound()
                sound.volume = config.volume
                sound.play()
                return
            }
        } else {
            // No custom sound set — use default blip.
            sound = defaultBlipSound()
        }

        sound.volume = config.volume
        sound.play()
    }

    /// Preview the sound configured for a specific event at the current volume,
    /// bypassing enabled checks. Uses the instance-aware `soundsDirectoryURL` so
    /// previews resolve correctly for non-default assistant instances.
    func previewSound(for event: SoundEvent) {
        let eventConfig = config.config(for: event)
        guard let filename = eventConfig.sound, !filename.isEmpty else {
            previewDefaultBlip()
            return
        }

        guard let fileURL = resolveCustomSoundURL(filename: filename) else {
            previewDefaultBlip()
            return
        }

        if let sound = NSSound(contentsOf: fileURL, byReference: true) {
            sound.volume = config.volume
            sound.play()
        } else {
            previewDefaultBlip()
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

    /// Resets the sound cache, forcing sounds to be reloaded from disk on next play.
    func clearCache() {
        soundCache.removeAll()
    }

    // MARK: - Available Sounds

    /// Lists audio files in the sounds directory, returning tuples of (label, filename).
    /// Label is the filename with the extension removed. Filters to supported extensions.
    /// This powers the Settings UI dropdown for sound selection.
    func availableSounds() -> [(label: String, filename: String)] {
        let dirURL = soundsDirectoryURL
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: dirURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return contents.compactMap { url in
            let ext = url.pathExtension.lowercased()
            guard supportedSoundExtensions.contains(ext) else { return nil }
            let filename = url.lastPathComponent
            let label = (filename as NSString).deletingPathExtension
            return (label: label, filename: filename)
        }
        .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    // MARK: - FSEvents File Watcher

    /// Watch config.json for external changes. Follows the same pattern as
    /// `AvatarAppearanceManager.watchAvatarFile()`.
    private func watchConfigFile() {
        fileMonitor?.cancel()
        fileMonitor = nil

        let path = configFileURL.path
        let fd = open(path, O_EVTONLY)

        if fd < 0 {
            // File doesn't exist yet — watch the parent directory instead.
            watchSoundsDirectory()
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
                self?.loadConfig()
                self?.clearCache()
                if flags.contains(.delete) || flags.contains(.rename) {
                    // File was deleted or renamed — re-establish the watcher
                    // (may fall back to directory watching if file is gone).
                    self?.watchConfigFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    /// Watch the sounds directory for file creation when config.json doesn't exist yet.
    /// Follows the same fallback pattern as `AvatarAppearanceManager.watchAvatarDirectory()`.
    private func watchSoundsDirectory() {
        let dirPath = (configFileURL.path as NSString).deletingLastPathComponent
        let fd = open(dirPath, O_EVTONLY)
        guard fd >= 0 else {
            // Directory doesn't exist either — try creating it and watching.
            let dirURL = soundsDirectoryURL
            try? FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
            let retryFd = open(dirURL.path, O_EVTONLY)
            guard retryFd >= 0 else { return }

            let retrySource = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: retryFd,
                eventMask: .write,
                queue: .global(qos: .utility)
            )

            retrySource.setEventHandler { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if FileManager.default.fileExists(atPath: self.configFileURL.path) {
                        self.loadConfig()
                        self.clearCache()
                        self.watchConfigFile()
                    }
                }
            }

            retrySource.setCancelHandler {
                close(retryFd)
            }

            fileMonitor = retrySource
            retrySource.resume()
            return
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: .write,
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if FileManager.default.fileExists(atPath: self.configFileURL.path) {
                    self.loadConfig()
                    self.clearCache()
                    self.watchConfigFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }
}
