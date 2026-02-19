import SwiftUI
import VellumAssistantShared

/// Renders work item output in a generic layout suitable for any task type.
/// Displays title, status badge, completion time, summary, and highlights.
enum TaskOutputRenderer {

    /// Formats a unix timestamp (seconds) into a human-readable date string.
    static func formattedDate(from timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp))
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    /// Returns a color for the given status string, falling back to textMuted
    /// for unrecognized values.
    static func statusColor(for status: String) -> Color {
        let normalized = WorkItemStatus(rawStatus: status)
        return TasksTableContract.statusStyle(for: normalized).color
    }

    /// Returns a display label for the given status string.
    static func statusLabel(for status: String) -> String {
        let normalized = WorkItemStatus(rawStatus: status)
        return TasksTableContract.statusStyle(for: normalized).label
    }
}
