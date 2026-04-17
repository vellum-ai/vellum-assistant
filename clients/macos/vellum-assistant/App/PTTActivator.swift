import Foundation
import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PTTActivator")

/// Describes how the push-to-talk activation input is detected.
struct PTTActivator: Codable, Equatable {

    enum Kind: String, Codable {
        case modifierOnly   // e.g. Fn, Ctrl, Fn+Shift
        case key            // e.g. F5, CapsLock
        case modifierKey    // e.g. Ctrl+F5, Cmd+M
        case mouseButton    // e.g. Mouse 4, Mouse 5
        case none           // PTT disabled
    }

    let kind: Kind
    let keyCode: UInt16?
    let modifierFlags: UInt?
    let mouseButton: Int?

    // MARK: - Factory Methods

    static func modifierOnly(flags: NSEvent.ModifierFlags) -> PTTActivator {
        PTTActivator(kind: .modifierOnly, keyCode: nil, modifierFlags: flags.rawValue, mouseButton: nil)
    }

    static func key(code: UInt16) -> PTTActivator {
        PTTActivator(kind: .key, keyCode: code, modifierFlags: nil, mouseButton: nil)
    }

    static func modifierKey(code: UInt16, flags: NSEvent.ModifierFlags) -> PTTActivator {
        PTTActivator(kind: .modifierKey, keyCode: code, modifierFlags: flags.rawValue, mouseButton: nil)
    }

    static func mouseButton(_ button: Int) -> PTTActivator {
        PTTActivator(kind: .mouseButton, keyCode: nil, modifierFlags: nil, mouseButton: button)
    }

    static let off = PTTActivator(kind: .none, keyCode: nil, modifierFlags: nil, mouseButton: nil)

    /// Safe default used when stored config is malformed.
    static let defaultActivator = PTTActivator.modifierOnly(flags: .function)

    // MARK: - Display Name

    var displayName: String {
        switch kind {
        case .modifierOnly:
            guard let raw = modifierFlags else { return "Fn" }
            let flags = NSEvent.ModifierFlags(rawValue: raw)
            return modifierDisplayName(flags)

        case .key:
            guard let code = keyCode else { return "Key" }
            return keyCodeName(code)

        case .modifierKey:
            guard let code = keyCode else { return "Key" }
            let keyName = keyCodeName(code)
            guard let raw = modifierFlags else { return keyName }
            let flags = NSEvent.ModifierFlags(rawValue: raw)
            let modName = modifierDisplayName(flags)
            return "\(modName)+\(keyName)"

        case .mouseButton:
            guard let button = mouseButton else { return "Mouse" }
            return "Mouse \(button)"

        case .none:
            return "Off"
        }
    }

    /// The `NSEvent.ModifierFlags` for this activator, if applicable.
    var nsModifierFlags: NSEvent.ModifierFlags? {
        guard let raw = modifierFlags else { return nil }
        return NSEvent.ModifierFlags(rawValue: raw)
    }

    // MARK: - Cache

    /// In-memory cache populated asynchronously so that the first
    /// UserDefaults read does not block the main thread during app launch.
    /// Access via `cached`; mutated only by `refreshCache()` / `updateCache()`.
    @MainActor private static var _cached: PTTActivator?

    /// Pre-computed human-readable name for `_cached`. Refreshed alongside
    /// `_cached` so hot paths (menu bar tooltip, settings row) read a cached
    /// string instead of re-running the `displayName` switch on every call.
    @MainActor private static var _cachedDisplayName: String = PTTActivator.defaultActivator.displayName

    /// In-flight cache load task. Stored so `ensureCacheReady()` can await
    /// a previously-started `warmCache()` without launching a second read.
    @MainActor private static var _cacheTask: Task<PTTActivator, Never>?

    /// Generation counter incremented on every cache write. Used by
    /// `ensureCacheReady()` to discard stale warm-cache results.
    @MainActor private static var _cacheGeneration: Int = 0

    /// Returns the cached activator, falling back to `defaultActivator`
    /// until the cache is populated.
    @MainActor static var cached: PTTActivator {
        _cached ?? .defaultActivator
    }

    /// Returns the cached `displayName` for the current activator. Paired
    /// with `cached` so callers on the main thread (e.g. the menu bar
    /// tooltip that fires on every connection-status change) avoid running
    /// the `displayName` switch during UI updates.
    @MainActor static var cachedDisplayName: String {
        _cachedDisplayName
    }

    /// Atomically writes the cache and its precomputed display name and
    /// bumps the generation counter. All mutators funnel through here so
    /// `_cached` and `_cachedDisplayName` never drift apart.
    @MainActor private static func applyCache(_ activator: PTTActivator) {
        _cached = activator
        _cachedDisplayName = activator.displayName
        _cacheGeneration += 1
    }

    /// Kicks off an async UserDefaults read without blocking the caller.
    /// Call this as early as possible (e.g. `applicationDidFinishLaunching`)
    /// so the result is ready by the time `ensureCacheReady()` is awaited.
    @MainActor static func warmCache() {
        guard _cacheTask == nil else { return }
        _cacheTask = Task.detached { Self.fromStored() }
    }

    /// Awaits the in-flight cache load (started by `warmCache()`) and
    /// applies the result **only if** no intervening `updateCache()` or
    /// `refreshCache()` has already populated a fresher value.
    @MainActor static func ensureCacheReady() async {
        if let task = _cacheTask {
            let gen = _cacheGeneration
            let result = await task.value
            // Only apply if no fresher write happened while we were awaiting.
            if _cacheGeneration == gen {
                applyCache(result)
            }
            _cacheTask = nil
        } else if _cached == nil {
            let result = await Task.detached { Self.fromStored() }.value
            applyCache(result)
        }
    }

    /// Re-reads UserDefaults off the main thread and updates the cache.
    /// Used when the activation key is changed remotely.
    @MainActor static func refreshCache() async {
        _cacheTask = nil
        let gen = _cacheGeneration
        let result = await Task.detached { Self.fromStored() }.value
        // Only apply if no fresher write happened while we were awaiting.
        if _cacheGeneration == gen {
            applyCache(result)
        }
    }

    /// Synchronously updates the cache after a local write (e.g. settings change).
    @MainActor static func updateCache(_ activator: PTTActivator) {
        _cacheTask = nil
        applyCache(activator)
    }

    // MARK: - Persistence

    /// Read the activator from UserDefaults, handling both legacy strings and JSON.
    /// Prefer `cached` on the main thread to avoid synchronous I/O during app launch.
    static func fromStored() -> PTTActivator {
        guard let stored = UserDefaults.standard.string(forKey: "activationKey") else {
            return .defaultActivator
        }

        // Try legacy string values first (fast path for existing users)
        if let legacy = fromLegacyString(stored) {
            return legacy
        }

        // Try JSON
        guard let data = stored.data(using: .utf8) else {
            log.warning("PTTActivator: stored value is not valid UTF-8, using default")
            return .defaultActivator
        }

        do {
            let activator = try JSONDecoder().decode(PTTActivator.self, from: data)
            if activator.isValid {
                return activator
            }
            log.warning("PTTActivator: stored JSON has invalid fields, using default")
            return .defaultActivator
        } catch {
            log.warning("PTTActivator: failed to decode stored value, using default: \(error.localizedDescription)")
            return .defaultActivator
        }
    }

    /// Store this activator as JSON in UserDefaults.
    func store() {
        do {
            let data = try JSONEncoder().encode(self)
            if let json = String(data: data, encoding: .utf8) {
                UserDefaults.standard.set(json, forKey: "activationKey")
            }
        } catch {
            log.error("PTTActivator: failed to encode: \(error.localizedDescription)")
        }
    }

    // MARK: - Legacy Migration

    private static func fromLegacyString(_ value: String) -> PTTActivator? {
        switch value {
        case "fn":       return .modifierOnly(flags: .function)
        case "ctrl":     return .modifierOnly(flags: .control)
        case "fn_shift": return .modifierOnly(flags: [.function, .shift])
        case "none":     return .off
        default:         return nil
        }
    }

    /// Convert back to a legacy string if this activator matches one of the presets.
    /// Used by onboarding which writes raw strings.
    var legacyString: String? {
        guard kind == .modifierOnly || kind == .none else { return nil }
        if kind == .none { return "none" }
        guard let raw = modifierFlags else { return nil }
        let flags = NSEvent.ModifierFlags(rawValue: raw)
        if flags == .function { return "fn" }
        if flags == .control { return "ctrl" }
        if flags == [.function, .shift] { return "fn_shift" }
        return nil
    }

    // MARK: - Validation

    private var isValid: Bool {
        switch kind {
        case .modifierOnly:
            return modifierFlags != nil && keyCode == nil && mouseButton == nil

        case .key:
            return keyCode != nil && mouseButton == nil

        case .modifierKey:
            return keyCode != nil && modifierFlags != nil && mouseButton == nil

        case .mouseButton:
            guard let button = mouseButton else { return false }
            return button >= 2 && keyCode == nil

        case .none:
            return true
        }
    }

    // MARK: - Key Code Names

    private func keyCodeName(_ code: UInt16) -> String {
        Self.keyCodeToName[code] ?? "Key \(code)"
    }

    private func modifierDisplayName(_ flags: NSEvent.ModifierFlags) -> String {
        var parts: [String] = []
        if flags.contains(.function) { parts.append("Fn") }
        if flags.contains(.control) { parts.append("Ctrl") }
        if flags.contains(.option) { parts.append("Opt") }
        if flags.contains(.shift) { parts.append("Shift") }
        if flags.contains(.command) { parts.append("Cmd") }
        return parts.isEmpty ? "Modifier" : parts.joined(separator: "+")
    }

    /// Map of common CGKeyCode values to human-readable names.
    static let keyCodeToName: [UInt16: String] = [
        // Letters (QWERTY layout)
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X",
        8: "C", 9: "V", 11: "B", 12: "Q", 13: "W", 14: "E", 15: "R",
        16: "Y", 17: "T", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6",
        23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0",
        30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P",
        37: "L", 38: "J", 39: "'", 40: "K", 41: ";", 42: "\\",
        43: ",", 44: "/", 45: "N", 46: "M", 47: ".",

        // Special keys
        36: "Return", 48: "Tab", 49: "Space", 51: "Delete",
        53: "Escape", 71: "Clear", 76: "Enter",

        // F-keys
        96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8",
        101: "F9", 103: "F11", 105: "F13", 107: "F14",
        109: "F10", 111: "F12", 113: "F15", 114: "Help",
        115: "Home", 116: "Page Up", 117: "Forward Delete",
        118: "F4", 119: "End", 120: "F2", 121: "Page Down", 122: "F1",

        // Arrow keys
        123: "Left", 124: "Right", 125: "Down", 126: "Up",

        // Numpad
        65: "Numpad .", 67: "Numpad *", 69: "Numpad +",
        75: "Numpad /", 78: "Numpad -", 81: "Numpad =",
        82: "Numpad 0", 83: "Numpad 1", 84: "Numpad 2",
        85: "Numpad 3", 86: "Numpad 4", 87: "Numpad 5",
        88: "Numpad 6", 89: "Numpad 7", 91: "Numpad 8", 92: "Numpad 9",

        // CapsLock
        57: "Caps Lock",
    ]
}
