import SwiftUI
import VellumAssistantShared

/// A single row in the trace timeline representing one trace event.
struct TraceRowView: View {
    let event: TraceStore.StoredEvent

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Image(systemName: iconName)
                .font(.system(size: 11))
                .foregroundColor(statusColor)
                .frame(width: 18, alignment: .center)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(event.summary)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(formattedTimestamp)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Icon

    private var iconName: String {
        switch event.kind {
        case "llm_call_started":
            return "brain"
        case "llm_call_finished":
            return "brain.head.profile"
        case "tool_started":
            return "wrench.and.screwdriver"
        case "tool_finished":
            return "wrench.and.screwdriver.fill"
        case "tool_failed":
            return "exclamationmark.triangle.fill"
        case "request_queued":
            return "tray.and.arrow.down"
        case "request_started":
            return "play.circle"
        case "request_finished":
            return "checkmark.circle"
        case "session_started":
            return "bolt.circle"
        case "session_ended":
            return "stop.circle"
        default:
            return "circle.fill"
        }
    }

    // MARK: - Status Color

    private var statusColor: Color {
        switch event.status {
        case "error":
            return Rose._500
        case "warning":
            return Amber._500
        case "success":
            return Emerald._400
        default:
            return Slate._400
        }
    }

    // MARK: - Timestamp

    private var formattedTimestamp: String {
        let date = Date(timeIntervalSince1970: event.timestampMs / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: date)
    }
}
