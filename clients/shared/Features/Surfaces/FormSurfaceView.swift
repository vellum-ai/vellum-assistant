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
                    .foregroundColor(VColor.contentDefault)

                if let desc = page.description {
                    Text(desc)
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
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
                        .foregroundColor(VColor.contentSecondary)
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
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
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
                    .font(VFont.caption)
            }
            .foregroundColor(VColor.contentSecondary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.xs)
            .background(VColor.surfaceBase.opacity(0.5))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingSecurityInfo) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Password Security")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)
                Text("Password values are masked in the UI using a secure text field. Submitted values are sent to the assistant for processing and are not logged.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
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
                    text: textBinding(for: field.id),
                    maxWidth: .infinity
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
                    text: textBinding(for: field.id),
                    maxWidth: .infinity
                )
                .onSubmit { handleEnterKey() }
            case .select:
                selectField(for: field)
            case .password:
                SecureField(
                    field.placeholder ?? "",
                    text: textBinding(for: field.id)
                )
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .padding(VSpacing.md)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
                )
                .onSubmit { handleEnterKey() }
            case .toggle:
                VToggle(isOn: toggleBinding(for: field.id))
            }
        }
    }

    @ViewBuilder
    private func fieldLabel(for field: FormField) -> some View {
        HStack(spacing: VSpacing.xxs) {
            Text(field.label)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.contentDefault)
            if field.required {
                Text("*")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.systemNegativeStrong)
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
        .foregroundColor(VColor.contentDefault)
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

    /// Resign focus and submit the form with visual feedback.
    private func doSubmit() {
        guard !isSubmitted else { return }
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

    private var submittedIndicator: some View {
        HStack(spacing: VSpacing.sm) {
            ProgressView()
                .controlSize(.small)
            Text("Submitting\u{2026}")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 32)
    }
}
