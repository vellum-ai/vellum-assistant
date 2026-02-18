import SwiftUI
import VellumAssistantShared

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
                .foregroundColor(VColor.textMuted)
            line
        }
        .padding(.vertical, VSpacing.xs)
    }

    private var line: some View {
        Rectangle()
            .fill(VColor.surfaceBorder.opacity(0.3))
            .frame(height: 0.5)
    }
}
