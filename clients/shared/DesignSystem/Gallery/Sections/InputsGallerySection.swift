#if DEBUG
import SwiftUI

struct InputsGallerySection: View {
    var filter: String?

    @State private var textFieldValue = ""
    @State private var textEditorValue = ""
    @State private var minHeight: CGFloat = 80
    @State private var maxHeight: CGFloat = 200
    @State private var sliderValue: Double = 50
    @State private var sliderSteppedValue: Double = 25
    @State private var sliderSmallValue: Double = 5
    @State private var toggleA: Bool = true
    @State private var toggleB: Bool = false
    @State private var dropdownValue = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vTextField" {
                // MARK: - VTextField
                GallerySectionHeader(
                    title: "VTextField",
                    description: "Single-line text input with optional leading/trailing icons."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Live value: \"\(textFieldValue)\"")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Plain").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(placeholder: "Type something...", text: $textFieldValue)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Leading icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(
                                placeholder: "Search...",
                                text: $textFieldValue,
                                leadingIcon: VIcon.search.rawValue
                            )
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Trailing icon").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(
                                placeholder: "Enter email...",
                                text: $textFieldValue,
                                trailingIcon: VIcon.mail.rawValue
                            )
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Both icons").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(
                                placeholder: "Search files...",
                                text: $textFieldValue,
                                leadingIcon: VIcon.search.rawValue,
                                trailingIcon: VIcon.circleX.rawValue
                            )
                        }

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Full width (default maxWidth: .infinity)")
                                .font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(placeholder: "Fills available width...", text: $textFieldValue)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Constrained width (maxWidth: 400)")
                                .font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VTextField(
                                placeholder: "Settings card width...",
                                text: $textFieldValue,
                                maxWidth: 400
                            )
                        }
                    }
                }
            }

            if filter == nil || filter == "vSlider" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VSlider
                GallerySectionHeader(
                    title: "VSlider",
                    description: "Custom slider with rounded capsule track, grip-line thumb, and optional tick marks."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Live value: \(Int(sliderValue))")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Default (0–100, step 1)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VSlider(value: $sliderValue)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("With tick marks (0–100, step 5): \(Int(sliderSteppedValue))")
                                .font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VSlider(value: $sliderSteppedValue, range: 0...100, step: 5, showTickMarks: true)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Small range (1–10, step 1): \(Int(sliderSmallValue))")
                                .font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VSlider(value: $sliderSmallValue, range: 1...10, step: 1, showTickMarks: true)
                        }
                    }
                }
            }

            if filter == nil || filter == "vTextEditor" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
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
                                    .foregroundColor(VColor.contentSecondary)
                                Slider(value: $minHeight, in: 40...200, step: 10)
                                    .frame(maxWidth: 200)
                            }
                            VStack(alignment: .leading) {
                                Text("Max Height: \(Int(maxHeight))")
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.contentSecondary)
                                Slider(value: $maxHeight, in: 100...400, step: 20)
                                    .frame(maxWidth: 200)
                            }
                        }

                        Divider().background(VColor.borderBase)

                        VTextEditor(
                            placeholder: "Write your thoughts...",
                            text: $textEditorValue,
                            minHeight: minHeight,
                            maxHeight: maxHeight
                        )

                        Text("Characters: \(textEditorValue.count)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }
            }

            if filter == nil || filter == "vToggle" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VToggle
                GallerySectionHeader(
                    title: "VToggle",
                    description: "Custom toggle switch with animated knob and color transition."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Toggle A: \(toggleA ? "ON" : "OFF")  |  Toggle B: \(toggleB ? "ON" : "OFF")")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("With label").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VToggle(isOn: $toggleA, label: "Enable feature")
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Without label").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VToggle(isOn: $toggleB)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Non-interactive").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VToggle(isOn: .constant(true), label: "Read-only toggle", interactive: false)
                        }
                    }
                }
            }

            if filter == nil || filter == "vDropdown" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - VDropdown
                GallerySectionHeader(
                    title: "VDropdown",
                    description: "Generic dropdown picker styled like VTextField, using native Menu for macOS popup behavior."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Live value: \"\(dropdownValue)\"")
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Empty state (placeholder visible)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VDropdown(
                                placeholder: "Select an option...",
                                selection: .constant(""),
                                options: [
                                    (label: "Option A", value: "a"),
                                    (label: "Option B", value: "b"),
                                    (label: "Option C", value: "c")
                                ],
                                emptyValue: ""
                            )
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Selected state (interactive)").font(VFont.caption).foregroundColor(VColor.contentTertiary)
                            VDropdown(
                                placeholder: "Select an option...",
                                selection: $dropdownValue,
                                options: [
                                    (label: "Option A", value: "a"),
                                    (label: "Option B", value: "b"),
                                    (label: "Option C", value: "c")
                                ],
                                emptyValue: ""
                            )
                        }
                    }
                }
            }

        }
    }
}

// MARK: - Component Page Router

extension InputsGallerySection {
    @ViewBuilder
    static func componentPage(_ id: String) -> some View {
        switch id {
        case "vTextField": InputsGallerySection(filter: "vTextField")
        case "vSlider": InputsGallerySection(filter: "vSlider")
        case "vTextEditor": InputsGallerySection(filter: "vTextEditor")
        case "vToggle": InputsGallerySection(filter: "vToggle")
        case "vDropdown": InputsGallerySection(filter: "vDropdown")
        default: EmptyView()
        }
    }
}
#endif
