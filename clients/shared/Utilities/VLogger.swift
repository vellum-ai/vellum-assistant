import Foundation
import os

/// Drop-in replacement for `os.Logger` that forwards error- and fault-level
/// messages to a configurable reporter (e.g. Sentry) in addition to the
/// unified logging system.
///
/// Usage:
/// ```swift
/// private let log = VLogger(subsystem: "com.vellum.vellum-assistant", category: "MyFeature")
/// log.info("loaded")           // → os.Logger only
/// log.error("something broke") // → os.Logger + error reporter (if configured)
/// ```
///
/// Configure the reporter at app startup:
/// ```swift
/// VLogger.errorReporter = { message, category in /* Sentry, analytics, etc. */ }
/// ```
public struct VLogger: Sendable {

    // MARK: - Error reporter hook

    /// Lock protecting `_errorReporter` so concurrent reads (from log call
    /// sites on arbitrary threads) and writes (from start/stop on the main
    /// thread) don't race.
    private static let _lock = NSLock()
    private static var _errorReporter: (@Sendable (String, String) -> Void)?

    /// Called for every `error()` and `fault()` log. Set once at app startup
    /// to bridge error logs into Sentry or another crash reporter.
    /// Parameters: (message: String, category: String).
    public static var errorReporter: (@Sendable (String, String) -> Void)? {
        get { _lock.lock(); defer { _lock.unlock() }; return _errorReporter }
        set { _lock.lock(); defer { _lock.unlock() }; _errorReporter = newValue }
    }

    // MARK: - Initialisation

    private let osLogger: Logger
    public let category: String

    public init(subsystem: String, category: String) {
        self.osLogger = Logger(subsystem: subsystem, category: category)
        self.category = category
    }

    // MARK: - Pass-through levels

    public func trace(_ message: String) { osLogger.trace("\(message)") }
    public func debug(_ message: String) { osLogger.debug("\(message)") }
    public func info(_ message: String) { osLogger.info("\(message)") }
    public func notice(_ message: String) { osLogger.notice("\(message)") }
    public func warning(_ message: String) { osLogger.warning("\(message)") }
    public func critical(_ message: String) { osLogger.critical("\(message)") }

    // MARK: - Error / Fault — captured to reporter

    /// Log an error and forward to the error reporter (e.g. Sentry).
    public func error(_ message: String) {
        osLogger.error("\(message, privacy: .public)")
        Self.errorReporter?(message, category)
    }

    /// Log a fault and forward to the error reporter (e.g. Sentry).
    public func fault(_ message: String) {
        osLogger.fault("\(message, privacy: .public)")
        Self.errorReporter?(message, category)
    }
}
