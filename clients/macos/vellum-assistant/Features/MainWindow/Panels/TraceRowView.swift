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
        case "request_received":
            return "play.circle"
        case "request_queued":
            return "tray.and.arrow.down"
        case "request_dequeued":
            return "tray.and.arrow.up"
        case "llm_call_started":
            return "brain"
        case "llm_call_finished":
            return "brain.head.profile"
        case "assistant_message":
            return "text.bubble"
        case "tool_started":
            return "wrench.and.screwdriver"
        case "tool_permission_requested":
            return "lock.shield"
        case "tool_permission_decided":
            return "lock.open"
        case "tool_finished":
            return "wrench.and.screwdriver.fill"
        case "tool_failed":
            return "exclamationmark.triangle.fill"
        case "secret_detected":
            return "eye.trianglebadge.exclamationmark"
        case "generation_handoff":
            return "arrow.right.arrow.left.circle"
        case "message_complete":
            return "checkmark.circle"
        case "generation_cancelled":
            return "xmark.circle"
        case "request_error":
            return "exclamationmark.circle"
        default:
            return "circle.fill"
        }
    }

    // MARK: - Status Color

    private var statusColor: Color {
        switch event.status {
        case "error":
            return Danger._500
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
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: date)
    }
}
