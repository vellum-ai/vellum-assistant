import Foundation
import SwiftUI

/// Pure-function formatters for ACP session row content.
///
/// Shared by ``ACPSessionsPanelRow`` (macOS) and ``ACPSessionsViewRow``
/// (iOS) so the two surfaces present coding-agent rows identically without
/// duplicating the label/colour/elapsed mapping. Keep this enum free of
/// platform-specific types — both row implementations import the shared
/// module, so anything that compiles here must work for both.
public enum ACPSessionStateFormatter {

    /// Human label for the agent that owns a session. Unknown ids fall
    /// through to the raw value so a new agent type still renders without
    /// a code change.
    public static func agentLabel(for agentId: String) -> String {
        switch agentId {
        case "claude-code": return "Claude"
        case "codex": return "Codex"
        default: return agentId
        }
    }

    /// Capitalised label for a status enum case.
    public static func statusLabel(_ status: ACPSessionState.Status) -> String {
        switch status {
        case .initializing: return "Starting"
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    /// Tint colour for a status enum case. Live sessions use the primary
    /// accent so they stand out from completed/terminal rows.
    public static func statusColor(_ status: ACPSessionState.Status) -> Color {
        switch status {
        case .running, .initializing: return VColor.primaryActive
        case .completed: return VColor.systemPositiveStrong
        case .failed, .cancelled: return VColor.systemNegativeStrong
        case .unknown: return VColor.contentTertiary
        }
    }

    /// Locale-aware "5m ago" for live sessions; wall-clock duration for
    /// terminated sessions so a finished row doesn't keep ticking.
    public static func elapsedLabel(startedAt: Int, completedAt: Int?) -> String {
        let started = Date(timeIntervalSince1970: TimeInterval(startedAt) / 1000)
        if let completedAt {
            let completed = Date(timeIntervalSince1970: TimeInterval(completedAt) / 1000)
            return VCollapsibleStepRowDurationFormatter.format(
                max(0, completed.timeIntervalSince(started))
            )
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: started, relativeTo: Date())
    }

    /// Returns `nil` for empty/missing ids so the metadata line degrades
    /// gracefully instead of rendering a stray separator.
    public static func parentConversationLabel(_ parentId: String?) -> String? {
        guard let parentId, !parentId.isEmpty else { return nil }
        let prefixLength = 8
        if parentId.count <= prefixLength { return parentId }
        return String(parentId.prefix(prefixLength)) + "…"
    }
}
