import SwiftUI

struct FormSurfaceView: View {
    let data: FormSurfaceData
    let onSubmit: ([String: Any]?) -> Void

    @State private var textValues: [String: String] = [:]
    @State private var toggleValues: [String: Bool] = [:]
    @State private var selectValues: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if let description = data.description {
                Text(description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }

            ForEach(data.fields) { field in
                fieldView(for: field)
            }

            VButton(
                label: data.submitLabel ?? "Submit",
                style: .primary,
                isFullWidth: true
            ) {
                submitForm()
            }
        }
        .onAppear {
            initializeDefaults()
        }
    }

    // MARK: - Field Rendering

    @ViewBuilder
    private func fieldView(for field: FormField) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            fieldLabel(for: field)

            switch field.type {
            case .text:
                VTextField(
                    placeholder: field.placeholder ?? "",
                    text: textBinding(for: field.id)
                )
            case .textarea:
                VTextEditor(
                    placeholder: field.placeholder ?? "",
                    text: textBinding(for: field.id)
                )
            case .number:
                VTextField(
                    placeholder: field.placeholder ?? "",
                    text: textBinding(for: field.id)
                )
            case .select:
                selectField(for: field)
            case .toggle:
                Toggle(isOn: toggleBinding(for: field.id)) {
                    EmptyView()
                }
                .toggleStyle(.switch)
                .tint(VColor.accent)
            }
        }
    }

    @ViewBuilder
    private func fieldLabel(for field: FormField) -> some View {
        HStack(spacing: VSpacing.xxs) {
            Text(field.label)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)
            if field.required {
                Text("*")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.error)
            }
        }
    }

    @ViewBuilder
    private func selectField(for field: FormField) -> some View {
        Picker("", selection: selectBinding(for: field.id)) {
            Text(field.placeholder ?? "Select...")
                .tag("")
            if let options = field.options {
                ForEach(options, id: \.value) { option in
                    Text(option.label).tag(option.value)
                }
            }
        }
        .pickerStyle(.menu)
        .font(VFont.body)
        .foregroundColor(VColor.textPrimary)
    }

    // MARK: - Bindings

    private func textBinding(for fieldId: String) -> Binding<String> {
        Binding(
            get: { textValues[fieldId] ?? "" },
            set: { textValues[fieldId] = $0 }
        )
    }

    private func toggleBinding(for fieldId: String) -> Binding<Bool> {
        Binding(
            get: { toggleValues[fieldId] ?? false },
            set: { toggleValues[fieldId] = $0 }
        )
    }

    private func selectBinding(for fieldId: String) -> Binding<String> {
        Binding(
            get: { selectValues[fieldId] ?? "" },
            set: { selectValues[fieldId] = $0 }
        )
    }

    // MARK: - Defaults & Submit

    private func initializeDefaults() {
        for field in data.fields {
            guard let defaultValue = field.defaultValue else { continue }
            switch field.type {
            case .text, .textarea, .number:
                textValues[field.id] = defaultValue.stringValue
            case .toggle:
                if case .boolean(let b) = defaultValue {
                    toggleValues[field.id] = b
                } else {
                    toggleValues[field.id] = (defaultValue.stringValue == "true")
                }
            case .select:
                selectValues[field.id] = defaultValue.stringValue
            }
        }
    }

    private func submitForm() {
        var values: [String: Any] = [:]
        for field in data.fields {
            switch field.type {
            case .text, .textarea, .number:
                values[field.id] = textValues[field.id] ?? ""
            case .toggle:
                values[field.id] = toggleValues[field.id] ?? false
            case .select:
                values[field.id] = selectValues[field.id] ?? ""
            }
        }
        onSubmit(values)
    }
}

#Preview {
    FormSurfaceView(
        data: FormSurfaceData(
            description: "Configure your assistant preferences.",
            fields: [
                FormField(id: "name", type: .text, label: "Name", placeholder: "Enter your name", required: true, defaultValue: nil, options: nil),
                FormField(id: "bio", type: .textarea, label: "Bio", placeholder: "Tell us about yourself", required: false, defaultValue: nil, options: nil),
                FormField(id: "role", type: .select, label: "Role", placeholder: "Select a role", required: true, defaultValue: nil, options: [
                    FormFieldOption(label: "Developer", value: "dev"),
                    FormFieldOption(label: "Designer", value: "design"),
                    FormFieldOption(label: "Manager", value: "pm"),
                ]),
                FormField(id: "notifications", type: .toggle, label: "Enable notifications", placeholder: nil, required: false, defaultValue: .boolean(true), options: nil),
            ],
            submitLabel: "Save"
        ),
        onSubmit: { _ in }
    )
    .padding()
    .frame(width: 380)
}
