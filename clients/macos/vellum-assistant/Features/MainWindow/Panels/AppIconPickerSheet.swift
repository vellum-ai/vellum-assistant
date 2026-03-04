import SwiftUI
import VellumAssistantShared

/// A sheet for picking an SF Symbol for an app icon.
struct AppIconPickerSheet: View {
    let appName: String
    let currentSymbol: String
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSymbol: String

    init(
        appName: String,
        currentSymbol: String,
        onSave: @escaping (String) -> Void
    ) {
        self.appName = appName
        self.currentSymbol = currentSymbol
        self.onSave = onSave
        _selectedSymbol = State(initialValue: currentSymbol)
    }

    private let symbolColumns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 6)

    var body: some View {
        VStack(spacing: VSpacing.xl) {
            // Header
            Text("Change Icon")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            // Live preview
            VStack(spacing: VSpacing.sm) {
                ZStack {
                    RoundedRectangle(cornerRadius: 96 * 0.22, style: .continuous)
                        .fill(Moss._100)
                    Image(systemName: selectedSymbol)
                        .font(.system(size: 42, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                }
                .frame(width: 96, height: 96)

                Text(appName)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Symbol picker
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("SYMBOL")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .tracking(1.2)

                ScrollView {
                    LazyVGrid(columns: symbolColumns, spacing: VSpacing.sm) {
                        ForEach(VAppIconGenerator.symbols, id: \.self) { symbol in
                            Button {
                                selectedSymbol = symbol
                            } label: {
                                Image(systemName: symbol)
                                    .font(.system(size: 16, weight: .medium))
                                    .foregroundColor(
                                        selectedSymbol == symbol
                                            ? VColor.accent
                                            : VColor.textSecondary
                                    )
                                    .frame(width: 36, height: 36)
                                    .background(
                                        RoundedRectangle(cornerRadius: VRadius.md)
                                            .fill(
                                                selectedSymbol == symbol
                                                    ? VColor.accent.opacity(0.15)
                                                    : VColor.surface
                                            )
                                    )
                                    .overlay(
                                        RoundedRectangle(cornerRadius: VRadius.md)
                                            .stroke(
                                                selectedSymbol == symbol
                                                    ? VColor.accent
                                                    : Color.clear,
                                                lineWidth: 2
                                            )
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(symbol)
                        }
                    }
                }
                .frame(maxHeight: 180)
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Buttons
            HStack {
                Button("Cancel") {
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(VColor.textSecondary)
                .font(VFont.body)

                Spacer()

                Button("Save") {
                    onSave(selectedSymbol)
                    dismiss()
                }
                .buttonStyle(.plain)
                .foregroundColor(VColor.accent)
                .font(VFont.bodyBold)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 320)
        .background(VColor.background)
    }
}

// MARK: - Preview

struct AppIconPickerSheet_Previews: PreviewProvider {
    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            AppIconPickerSheet(
                appName: "Safari",
                currentSymbol: "globe",
                onSave: { _ in }
            )
        }
        .frame(width: 360, height: 600)
    }
}
