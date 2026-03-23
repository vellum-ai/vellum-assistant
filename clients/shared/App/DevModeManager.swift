import Combine
import Foundation

/// Lightweight manager for dev mode state, backed by UserDefaults.
///
/// Extracted from `SettingsStore` so that early call sites (e.g.
/// `installCLISymlinkIfNeeded`) can check dev mode without triggering
/// the full `SettingsStore` lazy initialization and its network fetches.
@MainActor
public final class DevModeManager: ObservableObject {
    public static let shared = DevModeManager()

    @Published public var isDevMode: Bool {
        didSet { UserDefaults.standard.set(isDevMode, forKey: "devModeEnabled") }
    }

    private init() {
        #if DEBUG
        self.isDevMode = UserDefaults.standard.object(forKey: "devModeEnabled") as? Bool ?? true
        #else
        self.isDevMode = UserDefaults.standard.bool(forKey: "devModeEnabled")
        #endif
    }

    public func toggle() {
        isDevMode.toggle()
    }

    /// Thread-safe read of dev mode state directly from UserDefaults.
    /// Use this from non-MainActor contexts (e.g. `LockfileAssistant.loadAll()`).
    public nonisolated static var isDevModeEnabled: Bool {
        #if DEBUG
        UserDefaults.standard.object(forKey: "devModeEnabled") as? Bool ?? true
        #else
        UserDefaults.standard.bool(forKey: "devModeEnabled")
        #endif
    }
}
