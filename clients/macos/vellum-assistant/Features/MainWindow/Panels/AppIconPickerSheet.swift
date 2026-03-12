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
        VStack(spacing: VSpacing.xl) {
            // Header
            Text("Change Icon")
                .font(VFont.headline)
                .foregroundColor(VColor.contentDefault)

            // Live preview
            VStack(spacing: VSpacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: 96 * 0.22, style: .continuous)
                        .fill(VColor.surfaceBase)
                    VIconView(selectedIcon, size: 42)
                        .foregroundColor(VColor.contentTertiary)
                }
                .frame(width: 96, height: 96)

                Text(appName)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
            }

            Divider()
                .background(VColor.borderBase)

            // Icon picker
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("ICON")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .tracking(1.2)

                ScrollView {
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
                }
                .frame(maxHeight: 180)
            }

            Divider()
                .background(VColor.borderBase)

            // Buttons
            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(VColor.contentSecondary)
                .font(VFont.body)

                Spacer()

                Button("Save") {
                    onSave(selectedIcon)
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(VColor.primaryBase)
                .font(VFont.bodyBold)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 320)
        .background(VColor.surfaceOverlay)
    }
}

// MARK: - Preview

struct AppIconPickerSheet_Previews: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            AppIconPickerSheet(
                appName: "Safari",
                currentIcon: .globe,
                onSave: { _ in }
            )
        }
        .frame(width: 360, height: 600)
    }
}
