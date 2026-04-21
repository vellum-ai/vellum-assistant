import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct FormSurfaceView: View {
    public let data: FormSurfaceData
    public let onSubmit: ([String: Any]?) -> Void

    @State private var textValues: [String: String] = [:]
    @State private var toggleValues: [String: Bool] = [:]
    @State private var selectValues: [String: String] = [:]
    @State private var currentPageIndex: Int = 0
    @State private var showingSecurityInfo: Bool = false
    @State private var isSubmitted: Bool = false
    @State private var validationErrors: Set<String> = []

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
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                if let desc = page.description {
                    Text(desc)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
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
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                }

                if hasPasswordFields {
                    credentialInfoChip
                }

                ForEach(data.fields) { field in
                    fieldView(for: field)
                }

                if isSubmitted {
                    submittedIndicator
                } else {
                    VButton(
                        label: data.submitLabel ?? "Submit",
                        style: .primary,
                        isFullWidth: true
                    ) {
                        doSubmit()
                    }
                }
            }
        }
        .onAppear {
            initializeDefaults()
        }
        .onChange(of: textValues) {
            validationErrors = []
        }
        .onChange(of: selectValues) {
            validationErrors = []
        }
    }

    // MARK: - Page Navigation

    @ViewBuilder
    private func pageIndicator(currentPage: Int, totalPages: Int) -> some View {
        HStack(spacing: VSpacing.xs) {
            ForEach(0..<totalPages, id: \.self) { index in
                Circle()
                    .fill(index == currentPage ? VColor.primaryBase : VColor.borderBase)
                    .frame(width: 6, height: 6)
            }
            Spacer()
            Text("\(currentPage + 1) of \(totalPages)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    @ViewBuilder
    private func pageNavigation(currentPage: Int, totalPages: Int) -> some View {
        HStack(spacing: VSpacing.md) {
            if currentPage > 0 {
                VButton(
                    label: data.pageLabels?.back ?? "Back",
                    style: .outlined
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
                if isSubmitted {
                    submittedIndicator
                } else {
                    VButton(
                        label: data.pageLabels?.submit ?? data.submitLabel ?? "Submit",
                        style: .primary
                    ) {
                        doSubmit()
                    }
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
                VIconView(.shield, size: 12)
                Text("Secured input")
                    .font(VFont.labelDefault)
            }
            .foregroundStyle(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceOverlay.opacity(0.5))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingSecurityInfo) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Password Security")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text("Password values are masked in the UI using a secure text field. Submitted values are sent to the assistant for processing and are not logged.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
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
                .onSubmit { handleEnterKey() }
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
                .onSubmit { handleEnterKey() }
            case .select:
                selectField(for: field)
            case .password:
                VTextField(
                    placeholder: field.placeholder ?? "",
                    text: textBinding(for: field.id),
                    isSecure: true,
                    onSubmit: { handleEnterKey() }
                )
            case .toggle:
                VToggle(isOn: toggleBinding(for: field.id))
            }

            if validationErrors.contains(field.id) {
                Text("Required")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }

    @ViewBuilder
    private func fieldLabel(for field: FormField) -> some View {
        HStack(spacing: VSpacing.xxs) {
            Text(field.label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDefault)
            if field.required {
                Text("*")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
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
        .font(VFont.bodyMediumLighter)
        .foregroundStyle(VColor.contentDefault)
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

    /// In multi-page forms, Enter advances to the next page instead of submitting.
    /// Only submits on the last page or in single-page mode.
    private func handleEnterKey() {
        if let pages = data.pages, !pages.isEmpty, safePageIndex < pages.count - 1 {
            withAnimation(VAnimation.fast) {
                currentPageIndex += 1
            }
        } else {
            doSubmit()
        }
    }

    /// Validate that all required fields have non-empty values.
    /// Returns the set of field IDs that fail validation.
    private func validate() -> Set<String> {
        let allFields: [FormField]
        if let pages = data.pages {
            allFields = data.fields + pages.flatMap { $0.fields }
        } else {
            allFields = data.fields
        }
        var errors: Set<String> = []
        for field in allFields {
            guard field.required else { continue }
            switch field.type {
            case .text, .textarea, .number, .password:
                if textValues[field.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
                    errors.insert(field.id)
                }
            case .select:
                if selectValues[field.id]?.isEmpty != false {
                    errors.insert(field.id)
                }
            case .toggle:
                // Toggles always have a value (true/false), no validation needed
                break
            }
        }
        return errors
    }

    /// Resign focus and submit the form with visual feedback.
    private func doSubmit() {
        guard !isSubmitted else { return }

        let errors = validate()
        if !errors.isEmpty {
            validationErrors = errors
            isSubmitted = false
            // Navigate to the first page that contains a failing field
            if let pages = data.pages, !pages.isEmpty {
                for (index, page) in pages.enumerated() {
                    if page.fields.contains(where: { errors.contains($0.id) }) {
                        withAnimation(VAnimation.fast) {
                            currentPageIndex = index
                        }
                        break
                    }
                }
            }
            return
        }

        isSubmitted = true
        #if os(macOS)
        // Resign first responder so the SecureField doesn't swallow the click
        NSApp.keyWindow?.makeFirstResponder(nil)
        #endif
        submitForm()
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
            case .text, .textarea, .password:
                values[field.id] = textValues[field.id] ?? ""
            case .number:
                let raw = textValues[field.id] ?? ""
                if raw.isEmpty {
                    values[field.id] = NSNull()
                } else if let intVal = Int(raw) {
                    values[field.id] = intVal
                } else if let doubleVal = Double(raw) {
                    values[field.id] = doubleVal
                } else {
                    values[field.id] = raw  // fallback: unparseable string passes through
                }
            case .toggle:
                values[field.id] = toggleValues[field.id] ?? false
            case .select:
                values[field.id] = selectValues[field.id] ?? ""
            }
        }
        onSubmit(values)
    }

    private var submittedIndicator: some View {
        HStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("Submitting\u{2026}")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 32)
    }
}
