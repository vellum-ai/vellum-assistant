#if DEBUG
import SwiftUI

struct InputsGallerySection: View {
    @State private var textFieldValue = ""
    @State private var textEditorValue = ""
    @State private var minHeight: CGFloat = 80
    @State private var maxHeight: CGFloat = 200
    @State private var toggleA: Bool = true
    @State private var toggleB: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VTextField
            GallerySectionHeader(
                title: "VTextField",
                description: "Single-line text input with optional leading/trailing icons."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    Text("Live value: \"\(textFieldValue)\"")
                        .font(VFont.mono)
                        .foregroundColor(VColor.textMuted)

                    Divider().background(VColor.surfaceBorder)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Plain").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTextField(placeholder: "Type something...", text: $textFieldValue)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Leading icon").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTextField(
                            placeholder: "Search...",
                            text: $textFieldValue,
                            leadingIcon: "magnifyingglass"
                        )
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Trailing icon").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTextField(
                            placeholder: "Enter email...",
                            text: $textFieldValue,
                            trailingIcon: "envelope"
                        )
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Both icons").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VTextField(
                            placeholder: "Search files...",
                            text: $textFieldValue,
                            leadingIcon: "magnifyingglass",
                            trailingIcon: "xmark.circle"
                        )
                    }
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VTextEditor
            GallerySectionHeader(
                title: "VTextEditor",
                description: "Multi-line text editor with placeholder and height controls."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    HStack(spacing: VSpacing.xl) {
                        VStack(alignment: .leading) {
                            Text("Min Height: \(Int(minHeight))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                            Slider(value: $minHeight, in: 40...200, step: 10)
                                .frame(maxWidth: 200)
                        }
                        VStack(alignment: .leading) {
                            Text("Max Height: \(Int(maxHeight))")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textSecondary)
                            Slider(value: $maxHeight, in: 100...400, step: 20)
                                .frame(maxWidth: 200)
                        }
                    }

                    Divider().background(VColor.surfaceBorder)

                    VTextEditor(
                        placeholder: "Write your thoughts...",
                        text: $textEditorValue,
                        minHeight: minHeight,
                        maxHeight: maxHeight
                    )

                    Text("Characters: \(textEditorValue.count)")
                        .font(VFont.small)
                        .foregroundColor(VColor.textMuted)
                }
            }

            Divider().background(VColor.surfaceBorder).padding(.vertical, VSpacing.md)

            // MARK: - VToggle
            GallerySectionHeader(
                title: "VToggle",
                description: "Custom toggle switch with animated knob and color transition."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    Text("Toggle A: \(toggleA ? "ON" : "OFF")  |  Toggle B: \(toggleB ? "ON" : "OFF")")
                        .font(VFont.mono)
                        .foregroundColor(VColor.textMuted)

                    Divider().background(VColor.surfaceBorder)

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("With label").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VToggle(isOn: $toggleA, label: "Enable feature")
                    }

                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        Text("Without label").font(VFont.caption).foregroundColor(VColor.textMuted)
                        VToggle(isOn: $toggleB)
                    }
                }
            }
        }
    }
}
#endif
