import SwiftUI
import VellumAssistantShared

struct PreferencesRow: View {
    let isActive: Bool
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        SidebarPrimaryRow(
            icon: VIcon.slidersHorizontal.rawValue,
            label: "Preferences",
            isActive: isActive,
            trailingIcon: isActive ? VIcon.chevronDown.rawValue : VIcon.chevronUp.rawValue,
            isExpanded: isExpanded,
            action: onToggle
        )
    }
}
