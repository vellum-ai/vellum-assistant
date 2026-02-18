import SwiftUI

public struct FormSurfaceView: View {
    public let data: FormSurfaceData
    public let onSubmit: ([String: Any]?) -> Void

    @State private var textValues: [String: String] = [:]
    @State private var toggleValues: [String: Bool] = [:]
    @State private var selectValues: [String: String] = [:]
    @State private var currentPageIndex: Int = 0
    @State private var showingSecurityInfo: Bool = false

    private var safePageIndex: Int {
        guard let pages = data.pages, !pages.isEmpty else { return 0 }
        return max(0, min(currentPageIndex, pages.count - 1))
    }

    public init(data: FormSurfaceData, onSubmit: @escaping ([String: Any]?) -> Void) {
        self.data = data
        self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if let pages = data.pages, !pages.isEmpty {
                // Multi-page mode
                pageIndicator(currentPage: safePageIndex, totalPages: pages.count)

                let page = pages[safePageIndex]
                Text(page.title)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)

                if let desc = page.description {
                    Text(desc)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }

                if hasPasswordFields {
                    credentialInfoChip
                }

                ForEach(page.fields) { field in
                    fieldView(for: field)
                }

                pageNavigation(currentPage: safePageIndex, totalPages: pages.count)
            } else {
                // Single-page mode (existing behavior)
                if let description = data.description {
                    Text(description)
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }

                if hasPasswordFields {
                    credentialInfoChip
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
        }
        .onAppear {
            initializeDefaults()
        }
    }

    // MARK: - Page Navigation

    @ViewBuilder
    private func pageIndicator(currentPage: Int, totalPages: Int) -> some View {
        HStack(spacing: VSpacing.xs) {
            ForEach(0..<totalPages, id: \.self) { index in
                Circle()
                    .fill(index == currentPage ? VColor.accent : VColor.surfaceBorder)
                    .frame(width: 6, height: 6)
            }
            Spacer()
            Text("\(currentPage + 1) of \(totalPages)")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
    }

    @ViewBuilder
    private func pageNavigation(currentPage: Int, totalPages: Int) -> some View {
        HStack(spacing: VSpacing.md) {
            if currentPage > 0 {
                VButton(
                    label: data.pageLabels?.back ?? "Back",
                    style: .ghost
                ) {
                    withAnimation(VAnimation.fast) {
                        currentPageIndex -= 1
                    }
                }
            }
            Spacer()
            if currentPage < totalPages - 1 {
                VButton(
                    label: data.pageLabels?.next ?? "Next",
                    style: .primary
                ) {
                    withAnimation(VAnimation.fast) {
                        currentPageIndex += 1
                    }
                }
            } else {
                VButton(
                    label: data.pageLabels?.submit ?? data.submitLabel ?? "Submit",
                    style: .primary
                ) {
                    submitForm()
                }
            }
        }
    }

    // MARK: - Credential Info

    private var hasPasswordFields: Bool {
        let allFields: [FormField]
        if let pages = data.pages {
            allFields = data.fields + pages.flatMap { $0.fields }
        } else {
            allFields = data.fields
        }
        return allFields.contains { $0.type == .password }
    }

    @ViewBuilder
    private var credentialInfoChip: some View {
        Button(action: { showingSecurityInfo.toggle() }) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "lock.shield.fill")
                    .font(VFont.caption)
                Text("Stored securely")
                    .font(VFont.caption)
            }
            .foregroundColor(VColor.textSecondary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.backgroundSubtle.opacity(0.5))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingSecurityInfo) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Credential Security")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textPrimary)
                Text("Credentials are saved to the macOS Keychain. If unavailable, they're stored in an encrypted local file (~/.vellum/protected/). Values are never logged.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(VSpacing.lg)
            .frame(width: 260)
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
            case .password:
                SecureField(
                    field.placeholder ?? "",
                    text: textBinding(for: field.id)
                )
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
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
        let allFields: [FormField]
        if let pages = data.pages {
            allFields = data.fields + pages.flatMap { $0.fields }
        } else {
            allFields = data.fields
        }
        for field in allFields {
            guard let defaultValue = field.defaultValue else { continue }
            switch field.type {
            case .text, .textarea, .number, .password:
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
        let allFields: [FormField]
        if let pages = data.pages {
            allFields = data.fields + pages.flatMap { $0.fields }
        } else {
            allFields = data.fields
        }
        for field in allFields {
            switch field.type {
            case .text, .textarea, .number, .password:
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
