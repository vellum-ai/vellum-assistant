#if DEBUG
import SwiftUI

struct InputsGallerySection: View {
    @State private var textFieldValue = ""
    @State private var filledFieldValue = "Filled text"
    @State private var secureFieldValue = ""
    @State private var textEditorValue = ""
    @State private var minHeight: CGFloat = 80
    @State private var maxHeight: CGFloat = 200
    @State private var sliderValue: Double = 50
    @State private var sliderSteppedValue: Double = 25
    @State private var sliderSmallValue: Double = 5
    @State private var toggleA: Bool = true
    @State private var toggleB: Bool = false
    @State private var dropdownValue = ""
    @State private var dropdownFilledValue = "a"

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // MARK: - VTextField
            GallerySectionHeader(
                title: "VTextField",
                description: "Single-line text input with optional label, icons, secure mode, and error display."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    Text("Live value: \"\(textFieldValue)\"")
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentTertiary)

                    Divider().background(VColor.borderBase)

                    Text("Icons").font(VFont.captionMedium).foregroundColor(VColor.contentTertiary)

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

                    Divider().background(VColor.borderBase)

                    Text("States").font(VFont.captionMedium).foregroundColor(VColor.contentTertiary)

                    HStack(alignment: .top, spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            VTextField(
                                "Default",
                                placeholder: "Type something...",
                                text: $textFieldValue
                            )

                            VTextField(
                                "Filled",
                                placeholder: "Type something...",
                                text: $filledFieldValue
                            )

                            VTextField(
                                "Disabled",
                                placeholder: "Cannot edit",
                                text: .constant("")
                            )
                            .disabled(true)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            VTextField(
                                "Secure",
                                placeholder: "Enter API key...",
                                text: $secureFieldValue,
                                isSecure: true
                            )

                            VTextField(
                                "Error",
                                placeholder: "Required field",
                                text: .constant(""),
                                errorMessage: "This field is required"
                            )
                        }
                    }

                    Divider().background(VColor.borderBase)

                    Text("With label").font(VFont.captionMedium).foregroundColor(VColor.contentTertiary)

                    VTextField(
                        "Tool Name",
                        placeholder: "Select a Tool",
                        text: $textFieldValue,
                        leadingIcon: VIcon.search.rawValue
                    )
                }
            }

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

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

            Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)

            // MARK: - VDropdown
            GallerySectionHeader(
                title: "VDropdown",
                description: "Generic dropdown picker with optional label, error display, and icon support."
            )

            VCard {
                VStack(alignment: .leading, spacing: VSpacing.xl) {
                    Text("Live value: \"\(dropdownValue)\"")
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentTertiary)

                    Divider().background(VColor.borderBase)

                    Text("States").font(VFont.captionMedium).foregroundColor(VColor.contentTertiary)

                    HStack(alignment: .top, spacing: VSpacing.xl) {
                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            VDropdown(
                                "Default",
                                placeholder: "Select an option...",
                                selection: .constant(""),
                                options: [
                                    (label: "Option A", value: "a"),
                                    (label: "Option B", value: "b"),
                                    (label: "Option C", value: "c")
                                ],
                                emptyValue: ""
                            )

                            VDropdown(
                                "Filled",
                                placeholder: "Select an option...",
                                selection: $dropdownFilledValue,
                                options: [
                                    (label: "Option A", value: "a"),
                                    (label: "Option B", value: "b"),
                                    (label: "Option C", value: "c")
                                ],
                                emptyValue: ""
                            )

                            VDropdown(
                                "Disabled",
                                placeholder: "Cannot select",
                                selection: .constant(""),
                                options: [
                                    (label: "Option A", value: "a")
                                ],
                                emptyValue: ""
                            )
                            .disabled(true)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.lg) {
                            VDropdown(
                                "Error",
                                placeholder: "Select an option...",
                                selection: .constant(""),
                                options: [
                                    (label: "Option A", value: "a"),
                                    (label: "Option B", value: "b")
                                ],
                                emptyValue: "",
                                errorMessage: "Selection is required"
                            )

                            VDropdown(
                                "Interactive",
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
#endif
