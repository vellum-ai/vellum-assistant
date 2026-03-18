import SwiftUI
import VellumAssistantShared

/// A sheet for picking a Lucide icon for an app icon.
struct AppIconPickerSheet: View {
    let appName: String
    let currentIcon: VIcon
    let onSave: (VIcon) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedIcon: VIcon

    init(
        appName: String,
        currentIcon: VIcon,
        onSave: @escaping (VIcon) -> Void
    ) {
        self.appName = appName
        self.currentIcon = currentIcon
        self.onSave = onSave
        _selectedIcon = State(initialValue: currentIcon)
    }

    private let iconColumns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 6)

    var body: some View {
        VModal(title: "Change Icon") {
            LazyVGrid(columns: iconColumns, spacing: VSpacing.sm) {
                ForEach(VAppIconGenerator.icons, id: \.self) { icon in
                    Button {
                        selectedIcon = icon
                    } label: {
                        VIconView(icon, size: 16)
                            .foregroundColor(
                                selectedIcon == icon
                                    ? VColor.primaryBase
                                    : VColor.contentSecondary
                            )
                            .frame(width: 36, height: 36)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .fill(
                                        selectedIcon == icon
                                            ? VColor.primaryBase.opacity(0.15)
                                            : VColor.surfaceBase
                                    )
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.md)
                                    .stroke(
                                        selectedIcon == icon
                                            ? VColor.primaryBase
                                            : Color.clear,
                                        lineWidth: 2
                                    )
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(icon.rawValue)
                }
            }
        } footer: {
            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    dismiss()
                }
                VButton(label: "Save", style: .primary) {
                    onSave(selectedIcon)
                    dismiss()
                }
            }
        }
        .frame(width: 320)
    }
}

