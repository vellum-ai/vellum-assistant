import Foundation

/// Sliding-window tracker for authentication failures (HTTP 401 / 429).
///
/// A single transient 401 or 429 is not enough to conclude the auth path is
/// broken — proxies, brief credential refreshes, and rate limits all produce
/// isolated failures that recover on their own. `AuthFailureTracker` accumulates
/// failures within a rolling time window and only reports `isAuthFailed == true`
/// once at least `minFailures` have occurred inside `windowSeconds`. Any 2xx
/// response (signalled via `recordSuccess()`) immediately clears the window.
///
/// The default `windowSeconds=90` / `minFailures=4` is sized for the production
/// duty cycle of `GatewayConnectionManager.performHealthCheck()`, which fires
/// every 15s in steady state. Four sequential health checks at 401 land at
/// t≈0, 15, 30, 45 — all fit comfortably inside a 90s window with slack for
/// jitter. A 30s window (the original default) could hold at most 3 such
/// entries and so could never trip the detector.
///
/// The clock source is **monotonic and sleep-inclusive** (backed by
/// `mach_continuous_time()`), not wall-clock (`Date()`) and not
/// `DispatchTime.now()` / `mach_absolute_time()`. Pruning compares elapsed
/// seconds since an arbitrary fixed reference, so NTP adjustments, manual
/// clock changes, and daylight-savings transitions cannot corrupt the window
/// — a backward wall-clock jump would otherwise keep stale failures live, and
/// a forward jump would prune real ones. It also must advance while the
/// system is asleep: on macOS (the primary target), `DispatchTime.now()` and
/// `ProcessInfo.systemUptime` both pause during sleep, so a laptop that
/// accumulates 3 failures, sleeps for hours, and hits one more failure on
/// wake would trip the detector on what is really a single fresh failure.
/// `mach_continuous_time()` keeps advancing across sleep, so the window ages
/// correctly. The clock is injected so tests can drive time deterministically
/// without relying on `sleep`. All mutation is serialized through a private
/// `DispatchQueue` so the tracker is safe to call from a periodic health-check
/// task and from request-completion callbacks concurrently.
public final class AuthFailureTracker {
    private struct Entry {
        let timestamp: TimeInterval
        let statusCode: Int
        let path: String
    }

    public let windowSeconds: TimeInterval
    public let minFailures: Int
    private let now: () -> TimeInterval
    private let queue = DispatchQueue(label: "ai.vellum.AuthFailureTracker")

    private var entries: [Entry] = []
    private var _lastStatusCode: Int?
    private var _lastPath: String?

    public init(
        windowSeconds: TimeInterval = 90,
        minFailures: Int = 4,
        now: @escaping () -> TimeInterval = AuthFailureTracker.monotonicNow
    ) {
        self.windowSeconds = windowSeconds
        self.minFailures = minFailures
        self.now = now
    }

    private static let machTimebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    /// Default monotonic clock: seconds since an arbitrary fixed reference,
    /// sourced from `mach_continuous_time()`. Unlike `mach_absolute_time()`
    /// (which backs `DispatchTime.now()`), the continuous clock keeps
    /// advancing while the system is asleep — required on macOS so the
    /// 90s sliding window ages correctly across laptop sleep.
    public static func monotonicNow() -> TimeInterval {
        let ticks = mach_continuous_time()
        let nanos = ticks &* UInt64(machTimebase.numer) / UInt64(machTimebase.denom)
        return TimeInterval(nanos) / 1_000_000_000
    }

    /// Record a completed HTTP response. Only 401 and 429 contribute to the
    /// sliding window; every other status code is ignored. Entries older than
    /// `windowSeconds` are pruned on every call.
    public func recordFailure(statusCode: Int, path: String) {
        guard statusCode == 401 || statusCode == 429 else { return }
        queue.sync {
            let current = now()
            pruneLocked(relativeTo: current)
            entries.append(Entry(timestamp: current, statusCode: statusCode, path: path))
            _lastStatusCode = statusCode
            _lastPath = path
        }
    }

    /// Clear the entire window. Any 2xx health-check response means the auth
    /// path is working again, so accumulated failures should be discarded.
    public func recordSuccess() {
        queue.sync {
            entries.removeAll()
        }
    }

    /// `true` iff the post-prune count of in-window failures is at least
    /// `minFailures`.
    public var isAuthFailed: Bool {
        queue.sync {
            pruneLocked(relativeTo: now())
            return entries.count >= minFailures
        }
    }

    /// Most recent failure's status code, or `nil` if none has been recorded.
    public var lastStatusCode: Int? {
        queue.sync { _lastStatusCode }
    }

    /// Most recent failure's path, or `nil` if none has been recorded.
    public var lastPath: String? {
        queue.sync { _lastPath }
    }

    // MARK: - Private

    private func pruneLocked(relativeTo current: TimeInterval) {
        let cutoff = current - windowSeconds
        entries.removeAll { $0.timestamp < cutoff }
    }
}
