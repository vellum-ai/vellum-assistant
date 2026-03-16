import Foundation
import os

private let runtimeLoaderLog = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AppleContainersRuntimeLoader"
)

/// The result of attempting to load the optional Apple Containers runtime
/// module from the app bundle.
public enum AppleContainersRuntimeLoadResult: Sendable {
    /// The runtime module was found and loaded successfully.
    case loaded
    /// The runtime module is not embedded in this build of the app.
    case notEmbedded
    /// The runtime module was found but failed to load.
    case failed(reason: String)
}

/// Manages lazy, one-shot loading of the `AppleContainersRuntime` dynamic
/// library embedded inside the app bundle.
///
/// The main app target never imports `AppleContainersRuntime` directly.
/// Instead it uses this loader to dlopen the framework at runtime, keeping the
/// main package at macOS 14 while allowing Apple Containers to be used on
/// macOS 15+ when available.
///
/// Layout expected inside the app bundle:
/// ```
/// Contents/Frameworks/AppleContainersRuntime.framework/
///     AppleContainersRuntime          ← Mach-O dylib
/// ```
/// build.sh copies the framework here when it detects that the toolchain
/// supports macOS 15+.
public final class AppleContainersRuntimeLoader: @unchecked Sendable {
    public static let shared = AppleContainersRuntimeLoader()

    private let lock = NSLock()
    private var _result: AppleContainersRuntimeLoadResult?

    /// The framework bundle identifier used for look-up inside the app bundle.
    static let frameworkName = "AppleContainersRuntime"

    private init() {}

    /// Attempts to load the embedded runtime framework.  The result is cached
    /// and returned on subsequent calls without re-loading.
    ///
    /// This method is safe to call from any thread.
    public func load() -> AppleContainersRuntimeLoadResult {
        lock.lock()
        if let cached = _result {
            lock.unlock()
            return cached
        }
        lock.unlock()

        let result = attemptLoad()

        lock.lock()
        _result = result
        lock.unlock()

        return result
    }

    /// Resets the cached load result.  Intended for testing only.
    public func resetLoadResult() {
        lock.lock()
        _result = nil
        lock.unlock()
    }

    // MARK: - Private helpers

    private func attemptLoad() -> AppleContainersRuntimeLoadResult {
        guard let frameworkURL = locateFramework() else {
            runtimeLoaderLog.info(
                "AppleContainersRuntime framework not found in app bundle — runtime not embedded in this build."
            )
            return .notEmbedded
        }

        runtimeLoaderLog.debug(
            "Loading AppleContainersRuntime from \(frameworkURL.path, privacy: .public)"
        )

        let dylib = frameworkURL.appendingPathComponent(Self.frameworkName)
        guard FileManager.default.fileExists(atPath: dylib.path) else {
            let reason = "Expected dylib not found at \(dylib.path)"
            runtimeLoaderLog.error("\(reason, privacy: .public)")
            return .failed(reason: reason)
        }

        // Use dlopen so we don't link against the framework at build time.
        // RTLD_LAZY | RTLD_LOCAL avoids symbol conflicts with the main binary.
        guard let handle = dlopen(dylib.path, RTLD_LAZY | RTLD_LOCAL) else {
            let errorString = String(cString: dlerror())
            runtimeLoaderLog.error(
                "dlopen failed for AppleContainersRuntime: \(errorString, privacy: .public)"
            )
            return .failed(reason: errorString)
        }

        runtimeLoaderLog.info("AppleContainersRuntime loaded successfully.")

        // Call the bridge registration function exported by the runtime module.
        // This posts a `com.vellum.AppleContainersRuntimeDidLoad` notification
        // that `AppleContainersLauncher` observes to register the pod factory.
        let registrationSymbol = "vellum_register_pod_runtime_factory"
        if let sym = dlsym(handle, registrationSymbol) {
            typealias RegistrationFn = @convention(c) () -> Void
            let fn = unsafeBitCast(sym, to: RegistrationFn.self)
            fn()
            runtimeLoaderLog.info("AppleContainersRuntime: pod runtime factory registration triggered.")
        } else {
            runtimeLoaderLog.warning("AppleContainersRuntime: symbol '\(registrationSymbol, privacy: .public)' not found — pod factory registration skipped (older runtime build?).")
        }

        return .loaded
    }

    /// Searches for the embedded framework inside the app bundle's Frameworks
    /// directory.  Returns `nil` if the framework is absent.
    private func locateFramework() -> URL? {
        // Primary location: Contents/Frameworks (standard macOS app layout)
        if let frameworksURL = frameworksURL() {
            let candidate = frameworksURL
                .appendingPathComponent("\(Self.frameworkName).framework", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }

        // Fallback: next to the executable (used by `swift run` / direct builds)
        let executableDir = Bundle.main.executableURL?
            .deletingLastPathComponent()
        if let dir = executableDir {
            let candidate = dir
                .appendingPathComponent("\(Self.frameworkName).framework", isDirectory: true)
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }

        return nil
    }

    private func frameworksURL() -> URL? {
        // Contents/Frameworks is one level up from MacOS/
        return Bundle.main.executableURL?
            .deletingLastPathComponent()   // MacOS/
            .deletingLastPathComponent()   // Contents/
            .appendingPathComponent("Frameworks", isDirectory: true)
    }
}
