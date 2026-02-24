import SwiftUI
import Foundation

// MARK: - Work Item Status

/// Normalized status enum that maps daemon status strings to typed cases.
/// Case-insensitive matching protects against transport casing/serialization drift.
/// Shared between macOS and iOS so both platforms use the same mapping.
public enum WorkItemStatus: Equatable {
    case queued
    case running
    case awaitingReview
    case failed
    case cancelled
    case done
    case archived
    case unknown(String)

    /// Case-insensitive mapping from the raw daemon status string.
    public init(rawStatus: String) {
        switch rawStatus.lowercased() {
        case "queued":          self = .queued
        case "running":         self = .running
        case "awaiting_review", "awaiting review": self = .awaitingReview
        case "failed":          self = .failed
        case "cancelled":       self = .cancelled
        case "done", "complete", "completed": self = .done
        case "archived":        self = .archived
        default:                self = .unknown(rawStatus)
        }
    }
}

// MARK: - Table Column Definitions

/// Single source of truth for the Tasks table/list layout, column sizing,
/// priority/status display mappings, and sort order.
/// Shared between macOS and iOS.
///
/// Sorting rules (applied server-side, mirrored here for documentation):
///   1. `priority_tier ASC`  — high (0) surfaces first
///   2. `sort_index ASC`     — manual ordering within a tier
///   3. `updated_at DESC`    — most recently touched wins ties
public enum TasksTableContract {

    // MARK: Columns

    public enum Column: String, CaseIterable {
        case task
        case priority
        case status
        case actions
    }

    // MARK: Column Widths (macOS table layout)

    /// Fixed-width columns. The `task` column is flexible and fills remaining space.
    public static let taskMinWidth: CGFloat = 200
    public static let priorityWidth: CGFloat = 80
    public static let statusWidth: CGFloat = 120
    public static let actionsWidth: CGFloat = 90

    // MARK: Truncation

    /// Title truncates with trailing ellipsis at the column boundary (lineLimit 1).
    public static let titleLineLimit = 1

    // MARK: Priority Mapping

    public struct PriorityStyle {
        public let label: String
        public let color: Color

        public init(label: String, color: Color) {
            self.label = label
            self.color = color
        }
    }

    /// All priority tiers in display order, used to populate the priority edit menu.
    public static let allPriorityTiers: [(tier: Double, label: String, color: Color)] = [
        (0, "High",   VColor.error),
        (1, "Medium", VColor.accent),
        (2, "Low",    VColor.textMuted),
    ]

    public static func priorityStyle(for tier: Double) -> PriorityStyle {
        switch tier {
        case 0:  return PriorityStyle(label: "High",   color: VColor.error)
        case 1:  return PriorityStyle(label: "Medium", color: VColor.accent)
        default: return PriorityStyle(label: "Low",    color: VColor.textMuted)
        }
    }

    // MARK: Status Mapping

    public struct StatusStyle {
        public let label: String
        public let color: Color

        public init(label: String, color: Color) {
            self.label = label
            self.color = color
        }
    }

    public static func statusStyle(for status: WorkItemStatus) -> StatusStyle {
        switch status {
        case .queued:          return StatusStyle(label: "Queued",    color: VColor.textSecondary)
        case .running:         return StatusStyle(label: "Running",   color: VColor.textSecondary)
        case .awaitingReview:  return StatusStyle(label: "Awaiting Review", color: VColor.textSecondary)
        case .failed:          return StatusStyle(label: "Failed",    color: VColor.textSecondary)
        case .cancelled:       return StatusStyle(label: "Cancelled", color: VColor.textSecondary)
        case .done:            return StatusStyle(label: "Done",      color: VColor.textSecondary)
        case .archived:        return StatusStyle(label: "Archived",  color: VColor.textSecondary)
        case .unknown(let raw): return StatusStyle(label: raw,        color: VColor.textSecondary)
        }
    }
}
