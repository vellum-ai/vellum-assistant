import SwiftUI
import VellumAssistantShared

/// A single row in the trace timeline representing one trace event.
struct TraceRowView: View {
    let event: TraceStore.StoredEvent

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(iconToken, size: 11)
                .foregroundColor(statusColor)
                .frame(width: 18, alignment: .center)

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(event.summary)
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)

                Text(formattedTimestamp)
                    .font(VFont.labelSmall)
                    .foregroundColor(VColor.contentTertiary)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Icon

    private var iconToken: VIcon {
        switch event.kind {
        case "request_received":
            return .circlePlay
        case "request_queued":
            return .inbox
        case "request_dequeued":
            return .inbox
        case "llm_call_started":
            return .brain
        case "llm_call_finished":
            return .brain
        case "assistant_message":
            return .messageCircle
        case "tool_started":
            return .wrench
        case "tool_permission_requested":
            return .shield
        case "tool_permission_decided":
            return .lockOpen
        case "tool_finished":
            return .wrench
        case "tool_failed":
            return .triangleAlert
        case "secret_detected":
            return .eye
        case "generation_handoff":
            return .refreshCw
        case "message_complete":
            return .circleCheck
        case "generation_cancelled":
            return .circleX
        case "request_error":
            return .circleAlert
        default:
            return .circle
        }
    }

    // MARK: - Status Color

    private var statusColor: Color {
        switch event.status {
        case "error":
            return VColor.systemNegativeStrong
        case "warning":
            return VColor.systemMidStrong
        case "success":
            return VColor.systemPositiveStrong
        default:
            return VColor.contentTertiary
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
