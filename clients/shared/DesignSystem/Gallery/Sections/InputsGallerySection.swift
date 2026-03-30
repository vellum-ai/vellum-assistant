#if DEBUG
import SwiftUI

struct InputsGallerySection: View {
    var filter: String?

    @State private var textFieldValue = ""
    @State private var filledFieldValue = "Filled text"
    @State private var secureFieldValue = ""
    @State private var disabledFilledValue = "Read-only value"
    @State private var errorFilledValue = "Bad input"
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
    @State private var dropdownDisabledValue = "b"
    @State private var dropdownErrorValue = "a"
    @State private var formName = ""
    @State private var formDropdown = ""
    @State private var focusDemoValue = ""
    @State private var smallTextFieldValue = ""
    @State private var smallDropdownValue = ""
    @FocusState private var isFocusDemoFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            if filter == nil || filter == "vTextField" {
                // MARK: - VTextField
                GallerySectionHeader(
                    title: "VTextField",
                    description: "Single-line text input with optional label, icons, secure mode, and error display.",
                    useInsteadOf: "Raw TextField or SecureField with manual styling"
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Live value: \"\(textFieldValue)\"")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        // --- States ---
                        Text("States").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                VTextField(
                                    "Default (empty)",
                                    placeholder: "Type something...",
                                    text: $textFieldValue
                                )

                                VTextField(
                                    "Filled",
                                    placeholder: "Type something...",
                                    text: $filledFieldValue
                                )

                                VTextField(
                                    "Secure",
                                    placeholder: "Enter API key...",
                                    text: $secureFieldValue,
                                    isSecure: true
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                VTextField(
                                    "Disabled (empty)",
                                    placeholder: "Cannot edit",
                                    text: .constant("")
                                )
                                .disabled(true)

                                VTextField(
                                    "Disabled (filled)",
                                    placeholder: "Cannot edit",
                                    text: $disabledFilledValue
                                )
                                .disabled(true)

                                VTextField(
                                    "Error (empty)",
                                    placeholder: "Required field",
                                    text: .constant(""),
                                    errorMessage: "This field is required"
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                VTextField(
                                    "Error (filled)",
                                    placeholder: "Enter value",
                                    text: $errorFilledValue,
                                    errorMessage: "Invalid input"
                                )
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // --- Icons ---
                        Text("Icons").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Leading icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Search...",
                                    text: $textFieldValue,
                                    leadingIcon: VIcon.search.rawValue
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Trailing icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Enter email...",
                                    text: $textFieldValue,
                                    trailingIcon: VIcon.mail.rawValue
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Both icons").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Search files...",
                                    text: $textFieldValue,
                                    leadingIcon: VIcon.search.rawValue,
                                    trailingIcon: VIcon.circleX.rawValue
                                )
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // --- Label + Icon ---
                        Text("Label with icon").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        VTextField(
                            "Tool Name",
                            placeholder: "Select a Tool",
                            text: $textFieldValue,
                            leadingIcon: VIcon.search.rawValue
                        )

                        Divider().background(VColor.borderBase)

                        // --- Width Variants ---
                        Text("Width variants").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Full width (default maxWidth: .infinity)")
                                .font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VTextField(placeholder: "Fills available width...", text: $textFieldValue)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Constrained width (maxWidth: 400)")
                                .font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VTextField(
                                placeholder: "Settings card width...",
                                text: $textFieldValue,
                                maxWidth: 400
                            )
                        }

                        Divider().background(VColor.borderBase)

                        // --- Custom Font ---
                        Text("Custom font").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Monospaced (VFont.bodyMediumDefault)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Enter command...",
                                    text: $textFieldValue,
                                    font: VFont.bodyMediumDefault
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Monospaced secure").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Enter secret...",
                                    text: $secureFieldValue,
                                    isSecure: true,
                                    font: VFont.bodyMediumDefault
                                )
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // --- Size Variants ---
                        Text("Size variants").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Regular (default)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    "Label",
                                    placeholder: "Regular size...",
                                    text: $textFieldValue
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Small").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    "Label",
                                    placeholder: "Small size...",
                                    text: $smallTextFieldValue,
                                )
                            }
                        }

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Regular with icons").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Search...",
                                    text: $textFieldValue,
                                    leadingIcon: VIcon.search.rawValue,
                                    trailingIcon: VIcon.circleX.rawValue
                                )
                            }

                            VStack(alignment: .leading, spacing: VSpacing.md) {
                                Text("Small with icons").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                                VTextField(
                                    placeholder: "Search...",
                                    text: $smallTextFieldValue,
                                    leadingIcon: VIcon.search.rawValue,
                                    trailingIcon: VIcon.circleX.rawValue,
                                )
                            }
                        }

                        Divider().background(VColor.borderBase)

                        // --- External Focus Control ---
                        Text("External focus control").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Pass a FocusState<Bool>.Binding via isFocused: to control focus programmatically.")
                                .font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VAdaptiveStack(horizontalAlignment: .bottom) {
                                VTextField(
                                    "Focusable field",
                                    placeholder: "Click the button to focus me...",
                                    text: $focusDemoValue,
                                    isFocused: $isFocusDemoFocused
                                )
                                .frame(maxWidth: 400)
                                VButton(label: isFocusDemoFocused ? "Blur" : "Focus", style: .outlined) {
                                    isFocusDemoFocused.toggle()
                                }
                            }
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
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Default (0–100, step 1)").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VSlider(value: $sliderValue)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("With tick marks (0–100, step 5): \(Int(sliderSteppedValue))")
                                .font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VSlider(value: $sliderSteppedValue, range: 0...100, step: 5, showTickMarks: true)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Small range (1–10, step 1): \(Int(sliderSmallValue))")
                                .font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
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
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                Slider(value: $minHeight, in: 40...200, step: 10)
                                    .frame(maxWidth: 200)
                            }
                            VStack(alignment: .leading) {
                                Text("Max Height: \(Int(maxHeight))")
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
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
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("With label").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VToggle(isOn: $toggleA, label: "Enable feature")
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Without label").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
                            VToggle(isOn: $toggleB)
                        }

                        VStack(alignment: .leading, spacing: VSpacing.md) {
                            Text("Non-interactive").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
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
                    description: "Generic dropdown picker with optional label, error display, and icon support.",
                    useInsteadOf: "Raw Menu + Picker with manual styling"
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        Text("Live value: \"\(dropdownValue)\"")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)

                        Divider().background(VColor.borderBase)

                        // --- States ---
                        Text("States").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)

                        HStack(alignment: .top, spacing: VSpacing.xl) {
                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                VDropdown(
                                    "Default (empty)",
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

                            VStack(alignment: .leading, spacing: VSpacing.lg) {
                                VDropdown(
                                    "Disabled (empty)",
                                    placeholder: "Cannot select",
                                    selection: .constant(""),
                                    options: [
                                        (label: "Option A", value: "a")
                                    ],
                                    emptyValue: ""
                                )
                                .disabled(true)

                                VDropdown(
                                    "Disabled (filled)",
                                    placeholder: "Select an option...",
                                    selection: $dropdownDisabledValue,
                                    options: [
                                        (label: "Option A", value: "a"),
                                        (label: "Option B", value: "b")
                                    ],
                                    emptyValue: ""
                                )
                                .disabled(true)

                            }
                        }
                    }
                }
            }

            if filter == nil || filter == "combinedForm" {
                if filter == nil {
                    Divider().background(VColor.borderBase).padding(.vertical, VSpacing.md)
                }
                // MARK: - Combined Form Example
                GallerySectionHeader(
                    title: "Combined Form",
                    description: "VTextField and VDropdown used together in a form layout."
                )

                VCard {
                    VStack(alignment: .leading, spacing: VSpacing.lg) {
                        VTextField(
                            "Name",
                            placeholder: "Enter a name...",
                            text: $formName
                        )

                        VDropdown(
                            "Category",
                            placeholder: "Select a category...",
                            selection: $formDropdown,
                            options: [
                                (label: "General", value: "general"),
                                (label: "Technical", value: "technical"),
                                (label: "Design", value: "design")
                            ],
                            emptyValue: ""
                        )
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
        case "combinedForm": InputsGallerySection(filter: "combinedForm")
        default: EmptyView()
        }
    }
}
#endif
