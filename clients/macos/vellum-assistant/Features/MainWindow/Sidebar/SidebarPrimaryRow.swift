import SwiftUI
import VellumAssistantShared

/// Unified sidebar row used by both nav items and pinned apps.
/// Delegates to the shared `VSidebarRow` for layout and styling.
struct SidebarPrimaryRow: View {
    let icon: String
    let label: String
    var isActive: Bool = false
    var trailingIcon: String? = nil
    var isExpanded: Bool = true
    let action: () -> Void

    var body: some View {
        VSidebarRow(
            icon: icon,
            label: label,
            isActive: isActive,
            trailingIcon: trailingIcon,
            isExpanded: isExpanded,
            action: action
        )
    }
}

/// Convenience alias — existing callsites use `SidebarNavRow`.
typealias SidebarNavRow = SidebarPrimaryRow

// MARK: - Gallery Preview
