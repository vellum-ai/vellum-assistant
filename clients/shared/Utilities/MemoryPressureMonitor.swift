import Foundation
import Dispatch
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MemoryPressureMonitor")

/// System memory pressure level reported by the kernel.
///
/// - `normal`: system has sufficient free memory.
/// - `warning`: memory is constrained; cached work should be reduced.
/// - `critical`: memory is exhausted; non-essential work should be paused
///   and caches dropped before the process is jettisoned.
public enum MemoryPressureLevel: Equatable, Sendable {
    case normal
    case warning
    case critical

    /// Whether the system is under any elevated memory pressure.
    public var isElevated: Bool { self != .normal }
}

/// Process-wide monitor that exposes the current system memory pressure
/// level and notifies subscribers when it changes.
///
/// Wraps [`DispatchSource.makeMemoryPressureSource(eventMask:queue:)`](https://developer.apple.com/documentation/dispatch/dispatchsource/makememorypressuresource(eventmask:queue:))
/// so subsystems that do periodic main-thread work (snapshot writers, health
/// checks, background polling loops) can consult a single source of truth
/// instead of each registering their own dispatch source.
///
/// Apple's guidance: when memory pressure events fire, "free cached resources"
/// and reduce non-essential work. See WWDC18 session
/// [416 — iOS Memory Deep Dive](https://developer.apple.com/videos/play/wwdc2018/416/)
/// and the [Dispatch](https://developer.apple.com/documentation/dispatch)
/// framework reference.
///
/// The monitor is safe to use from any thread. Listener callbacks are
/// delivered on the main queue so SwiftUI state updates are valid.
public final class MemoryPressureMonitor: @unchecked Sendable {
    /// Shared instance. Call ``start()`` once at app launch.
    public static let shared = MemoryPressureMonitor()

    /// Listener token returned by ``addListener(_:)``; pass to
    /// ``removeListener(_:)`` to unsubscribe.
    public typealias ListenerToken = UUID

    /// Serial queue that owns the underlying `DispatchSourceMemoryPressure`
    /// and all internal mutable state (listeners dictionary, cached level).
    private let queue = DispatchQueue(label: "com.vellum.memory-pressure-monitor", qos: .utility)

    private let stateLock = NSLock()
    private var _current: MemoryPressureLevel = .normal
    private var listeners: [ListenerToken: @Sendable (MemoryPressureLevel) -> Void] = [:]
    private var source: DispatchSourceMemoryPressure?
    private var started = false

    private init() {}

    /// The most recently observed memory pressure level.
    ///
    /// Defaults to ``MemoryPressureLevel/normal`` before the monitor has
    /// been started or any event has fired.
    public var current: MemoryPressureLevel {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _current
    }

    /// Begin observing system memory pressure events. Idempotent — safe to
    /// call multiple times.
    public func start() {
        queue.async { [weak self] in
            guard let self, !self.started else { return }
            self.started = true
            let src = DispatchSource.makeMemoryPressureSource(
                eventMask: [.normal, .warning, .critical],
                queue: self.queue
            )
            src.setEventHandler { [weak self, weak src] in
                guard let self, let src else { return }
                let data = src.data
                let level: MemoryPressureLevel
                if data.contains(.critical) {
                    level = .critical
                } else if data.contains(.warning) {
                    level = .warning
                } else {
                    level = .normal
                }
                self.update(to: level)
            }
            src.resume()
            self.source = src
        }
    }

    /// Register a listener that fires on the main queue whenever the level
    /// changes. Returns a token that must be passed to
    /// ``removeListener(_:)`` to unsubscribe.
    ///
    /// The listener is not invoked for the current level at registration
    /// time — callers that need the initial value should read ``current``
    /// after subscribing.
    @discardableResult
    public func addListener(_ callback: @escaping @Sendable (MemoryPressureLevel) -> Void) -> ListenerToken {
        let token = ListenerToken()
        stateLock.lock()
        listeners[token] = callback
        stateLock.unlock()
        return token
    }

    /// Remove a previously-registered listener. No-op if the token is
    /// unknown (e.g. already removed).
    public func removeListener(_ token: ListenerToken) {
        stateLock.lock()
        listeners.removeValue(forKey: token)
        stateLock.unlock()
    }

    private func update(to level: MemoryPressureLevel) {
        stateLock.lock()
        let changed = _current != level
        _current = level
        let snapshot = changed ? Array(listeners.values) : []
        stateLock.unlock()

        guard changed else { return }
        log.info("Memory pressure level changed to \(String(describing: level), privacy: .public)")
        for callback in snapshot {
            DispatchQueue.main.async {
                callback(level)
            }
        }
    }

    // MARK: - Testing Hooks

    /// Inject a synthetic memory pressure level. Intended for unit tests
    /// that exercise subscribers without touching the real dispatch source.
    internal func _testingSetLevel(_ level: MemoryPressureLevel) {
        update(to: level)
    }
}
