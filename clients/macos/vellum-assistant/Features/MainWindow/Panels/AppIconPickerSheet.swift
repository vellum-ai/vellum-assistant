import SwiftUI
import VellumAssistantShared

/// A sheet for picking an SF Symbol and gradient background for an app icon.
struct AppIconPickerSheet: View {
    let appName: String
    let currentSymbol: String
    let currentColors: [String]
    let onSave: (String, [String]) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedSymbol: String
    @State private var selectedColors: [String]

    init(
        appName: String,
        currentSymbol: String,
        currentColors: [String],
        onSave: @escaping (String, [String]) -> Void
    ) {
        self.appName = appName
        self.currentSymbol = currentSymbol
        self.currentColors = currentColors
        self.onSave = onSave
        _selectedSymbol = State(initialValue: currentSymbol)
        _selectedColors = State(initialValue: currentColors)
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
                VAppIcon(
                    sfSymbol: selectedSymbol,
                    gradientColors: selectedColors,
                    size: .large
                )
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

            // Color picker
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("COLOR")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .tracking(1.2)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: VSpacing.sm) {
                        ForEach(VAppIconGenerator.gradientPalettes, id: \.self) { palette in
                            let isSelected = palette == selectedColors
                            Button {
                                selectedColors = palette
                            } label: {
                                Circle()
                                    .fill(
                                        LinearGradient(
                                            colors: palette.map { Color(hexString: $0) },
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        )
                                    )
                                    .frame(width: 28, height: 28)
                                    .overlay(
                                        Circle()
                                            .stroke(
                                                isSelected ? VColor.accent : Color.clear,
                                                lineWidth: 2.5
                                            )
                                            .padding(-3)
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Gradient swatch")
                        }
                    }
                    .padding(.horizontal, VSpacing.xs)
                    .padding(.vertical, VSpacing.xs)
                }
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
                    onSave(selectedSymbol, selectedColors)
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
                currentColors: ["#059669", "#10B981"],
                onSave: { _, _ in }
            )
        }
        .frame(width: 360, height: 600)
    }
}
