import Foundation

/// Resolves the host's configured timezone with caching.
/// Prefers the host's configured timezone over process-level TZ overrides
/// so chat dividers stay in the user's real local timezone.
public enum ChatTimestampTimeZone {
    private static var cachedZone: TimeZone?
    private static var cacheTimestamp: Date?
    private static let cacheInterval: TimeInterval = 60
    private static var observer: NSObjectProtocol?

    /// Resolve the host timezone, caching the result to avoid repeated filesystem reads
    /// in hot rendering paths.
    public static func resolve() -> TimeZone {
        // Check if we have a valid cached value
        if let cached = cachedZone,
           let timestamp = cacheTimestamp,
           Date().timeIntervalSince(timestamp) < cacheInterval {
            return cached
        }

        // Register for timezone change notifications if not already registered
        if observer == nil {
            observer = NotificationCenter.default.addObserver(
                forName: NSNotification.Name.NSSystemTimeZoneDidChange,
                object: nil,
                queue: .main
            ) { _ in
                cachedZone = nil
                cacheTimestamp = nil
            }
        }

        // Resolve timezone from /etc/localtime
        let resolved: TimeZone
        #if os(macOS)
        if let symlink = try? FileManager.default.destinationOfSymbolicLink(atPath: "/etc/localtime"),
           let markerRange = symlink.range(of: "/zoneinfo/") {
            let identifier = String(symlink[markerRange.upperBound...])
            resolved = TimeZone(identifier: identifier) ?? .autoupdatingCurrent
        } else {
            resolved = .autoupdatingCurrent
        }
        #else
        // iOS doesn't have /etc/localtime — use autoupdating directly
        resolved = .autoupdatingCurrent
        #endif

        // Update cache
        cachedZone = resolved
        cacheTimestamp = Date()

        return resolved
    }
}
