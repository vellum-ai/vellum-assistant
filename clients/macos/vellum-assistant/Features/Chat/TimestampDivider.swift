import SwiftUI
import VellumAssistantShared

/// Resolves the host's configured timezone (independent of process-level TZ overrides)
/// so chat dividers stay in the user's real local timezone.
/// Caches the result to avoid repeated filesystem reads in hot rendering paths.
enum ChatTimestampTimeZone {
    private static var cachedZone: TimeZone?
    private static var cacheTimestamp: Date?
    private static let cacheInterval: TimeInterval = 60
    private static var observer: NSObjectProtocol?

    static func resolve() -> TimeZone {
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
        if let symlink = try? FileManager.default.destinationOfSymbolicLink(atPath: "/etc/localtime"),
           let markerRange = symlink.range(of: "/zoneinfo/") {
            let identifier = String(symlink[markerRange.upperBound...])
            resolved = TimeZone(identifier: identifier) ?? .autoupdatingCurrent
        } else {
            resolved = .autoupdatingCurrent
        }

        // Update cache
        cachedZone = resolved
        cacheTimestamp = Date()

        return resolved
    }
}

/// A thin horizontal line with a relative timestamp label, used to visually
/// separate messages that are far apart in time.
struct TimestampDivider: View {
    let date: Date

    private var formattedTime: String {
        let tz = ChatTimestampTimeZone.resolve()
        var calendar = Calendar.current
        calendar.timeZone = tz
        let formatter = DateFormatter()
        formatter.timeZone = tz
        formatter.dateFormat = "h:mm a"
        let timeString = formatter.string(from: date)
        if calendar.isDateInToday(date) {
            return "Today at \(timeString)"
        } else if calendar.isDateInYesterday(date) {
            return "Yesterday at \(timeString)"
        } else {
            let dayFormatter = DateFormatter()
            dayFormatter.timeZone = tz
            dayFormatter.dateFormat = "MMM d"
            return "\(dayFormatter.string(from: date)) at \(timeString)"
        }
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            line
            Text(formattedTime)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
            line
        }
        .padding(.vertical, VSpacing.xs)
    }

    private var line: some View {
        Rectangle()
            .fill(VColor.borderBase.opacity(0.3))
            .frame(height: 0.5)
    }
}
