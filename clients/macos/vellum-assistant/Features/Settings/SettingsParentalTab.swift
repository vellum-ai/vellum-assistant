import SwiftUI
import VellumAssistantShared

// MARK: - Parental Control Settings Tab

/// Settings tab for configuring parental controls: PIN lock, content topic
/// restrictions, and tool category blocks.
@MainActor
struct SettingsParentalTab: View {
    var daemonClient: DaemonClient?

    // -- Remote state (loaded from daemon) --
    @State private var isEnabled: Bool = false
    @State private var hasPIN: Bool = false
    @State private var contentRestrictions: Set<String> = []
    @State private var blockedToolCategories: Set<String> = []

    // -- Local UI state --
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    // -- PIN sheet --
    @State private var showingPINSheet: Bool = false
    @State private var pinSheetMode: PINSheetMode = .set

    // -- Unlock overlay (shown when settings are locked) --
    @State private var showingUnlockSheet: Bool = false
    @State private var isUnlocked: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            // Header + enable toggle
            enableSection

            if isEnabled {
                if isUnlocked || !hasPIN {
                    pinSection
                    contentRestrictionsSection
                    toolCategorySection
                } else {
                    lockedPlaceholder
                }
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
            if let success = successMessage {
                Text(success)
                    .font(VFont.caption)
                    .foregroundColor(VColor.success)
            }

            Spacer()
        }
        .onAppear { loadSettings() }
        .sheet(isPresented: $showingPINSheet) {
            PINSheet(
                mode: pinSheetMode,
                onComplete: { result in
                    showingPINSheet = false
                    switch result {
                    case .success(let mode):
                        switch mode {
                        case .set:
                            hasPIN = true
                            successMessage = "PIN set."
                        case .change:
                            successMessage = "PIN changed."
                        case .clear:
                            hasPIN = false
                            isUnlocked = false
                            successMessage = "PIN cleared."
                        }
                    case .failure(let msg):
                        errorMessage = msg
                    }
                },
                daemonClient: daemonClient
            )
        }
        .sheet(isPresented: $showingUnlockSheet) {
            UnlockSheet(
                onComplete: { unlocked in
                    showingUnlockSheet = false
                    if unlocked {
                        isUnlocked = true
                        errorMessage = nil
                    } else {
                        errorMessage = "Incorrect PIN."
                    }
                },
                daemonClient: daemonClient
            )
        }
    }

    // MARK: - Sections

    private var enableSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Parental Controls")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Restrict the assistant's capabilities and content topics. A PIN protects these settings from being changed.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                Toggle("Enable Parental Controls", isOn: Binding(
                    get: { isEnabled },
                    set: { newValue in
                        // Toggling off a PIN-locked session requires PIN verification
                        if !newValue && isEnabled && hasPIN && !isUnlocked {
                            showingUnlockSheet = true
                        } else {
                            updateEnabled(newValue)
                        }
                    }
                ))
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .disabled(isLoading)

                if isLoading {
                    ProgressView()
                        .scaleEffect(0.6)
                        .padding(.leading, VSpacing.xs)
                }
            }
        }
    }

    private var pinSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("PIN Lock")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text(hasPIN
                ? "A 6-digit PIN protects these settings. You must enter it to make changes."
                : "Set a 6-digit PIN to lock parental control settings.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: VSpacing.sm) {
                if hasPIN {
                    VButton(label: "Change PIN", style: .secondary) {
                        errorMessage = nil
                        successMessage = nil
                        pinSheetMode = .change
                        showingPINSheet = true
                    }
                    VButton(label: "Remove PIN", style: .danger) {
                        errorMessage = nil
                        successMessage = nil
                        pinSheetMode = .clear
                        showingPINSheet = true
                    }
                } else {
                    VButton(label: "Set PIN", style: .primary) {
                        errorMessage = nil
                        successMessage = nil
                        pinSheetMode = .set
                        showingPINSheet = true
                    }
                }
            }
        }
    }

    private var contentRestrictionsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Content Restrictions")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Block responses on these topics.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            ForEach(ContentTopic.allCases) { topic in
                Toggle(topic.displayName, isOn: Binding(
                    get: { contentRestrictions.contains(topic.rawValue) },
                    set: { enabled in
                        var updated = contentRestrictions
                        if enabled { updated.insert(topic.rawValue) } else { updated.remove(topic.rawValue) }
                        updateContentRestrictions(Array(updated))
                    }
                ))
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .disabled(isLoading)
            }
        }
    }

    private var toolCategorySection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Tool Restrictions")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Prevent the assistant from using these tool categories.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            ForEach(ToolCategory.allCases) { category in
                VStack(alignment: .leading, spacing: 2) {
                    Toggle(category.displayName, isOn: Binding(
                        get: { blockedToolCategories.contains(category.rawValue) },
                        set: { blocked in
                            var updated = blockedToolCategories
                            if blocked { updated.insert(category.rawValue) } else { updated.remove(category.rawValue) }
                            updateToolCategories(Array(updated))
                        }
                    ))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .disabled(isLoading)

                    Text(category.description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .padding(.leading, 20)
                }
            }
        }
    }

    private var lockedPlaceholder: some View {
        VStack(spacing: VSpacing.md) {
            Image(systemName: "lock.fill")
                .font(.system(size: 28))
                .foregroundColor(VColor.textMuted)

            Text("Settings are locked")
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.textSecondary)

            Text("Enter your PIN to make changes.")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            VButton(label: "Unlock", style: .primary) {
                errorMessage = nil
                showingUnlockSheet = true
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VSpacing.xxl)
    }

    // MARK: - Daemon interactions

    private func loadSettings() {
        isLoading = true
        errorMessage = nil

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlGet()
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = "Failed to load settings: \(error.localizedDescription)"
                }
                return
            }

            // Wait for the response (with timeout)
            let response: ParentalControlGetResponseMessage? = await withTaskGroup(of: ParentalControlGetResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlGetResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    isEnabled = r.enabled
                    hasPIN = r.has_pin
                    contentRestrictions = Set(r.content_restrictions)
                    blockedToolCategories = Set(r.blocked_tool_categories)
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }

    private func updateEnabled(_ enabled: Bool) {
        isLoading = true
        errorMessage = nil
        successMessage = nil

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(enabled: enabled)
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        isEnabled = r.enabled
                        hasPIN = r.has_pin
                        contentRestrictions = Set(r.content_restrictions)
                        blockedToolCategories = Set(r.blocked_tool_categories)
                    } else {
                        errorMessage = r.error ?? "Update failed."
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }

    private func updateContentRestrictions(_ restrictions: [String]) {
        isLoading = true
        errorMessage = nil
        successMessage = nil

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(contentRestrictions: restrictions)
            } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response, r.success {
                    contentRestrictions = Set(r.content_restrictions)
                } else {
                    errorMessage = response?.error ?? "Update failed."
                    // revert local toggle
                    loadSettings()
                }
            }
        }
    }

    private func updateToolCategories(_ categories: [String]) {
        isLoading = true
        errorMessage = nil
        successMessage = nil

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlUpdate(blockedToolCategories: categories)
            } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }

            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlUpdateResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response, r.success {
                    blockedToolCategories = Set(r.blocked_tool_categories)
                } else {
                    errorMessage = response?.error ?? "Update failed."
                    loadSettings()
                }
            }
        }
    }
}

// MARK: - PIN Sheet

private enum PINSheetMode {
    case set, change, clear
}

private enum PINSheetResult {
    case success(PINSheetMode)
    case failure(String)
}

@MainActor
private struct PINSheet: View {
    let mode: PINSheetMode
    let onComplete: (PINSheetResult) -> Void
    var daemonClient: DaemonClient?

    @State private var currentPIN: String = ""
    @State private var newPIN: String = ""
    @State private var confirmPIN: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?

    @Environment(\.dismiss) private var dismiss

    private var title: String {
        switch mode {
        case .set: return "Set PIN"
        case .change: return "Change PIN"
        case .clear: return "Remove PIN"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            if mode == .change || mode == .clear {
                SecureField("Current PIN (6 digits)", text: $currentPIN)
                    .textFieldStyle(.roundedBorder)
                    .font(VFont.body)
            }

            if mode == .set || mode == .change {
                SecureField("New PIN (6 digits)", text: $newPIN)
                    .textFieldStyle(.roundedBorder)
                    .font(VFont.body)

                SecureField("Confirm new PIN", text: $confirmPIN)
                    .textFieldStyle(.roundedBorder)
                    .font(VFont.body)
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            HStack {
                Spacer()
                VButton(label: "Cancel", style: .secondary) {
                    dismiss()
                }
                VButton(label: "Confirm", style: .primary) {
                    submit()
                }
                .disabled(isLoading || !canSubmit)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 320)
        .background(VColor.background)
    }

    private var canSubmit: Bool {
        switch mode {
        case .set:
            return newPIN.count == 6 && confirmPIN == newPIN
        case .change:
            return currentPIN.count == 6 && newPIN.count == 6 && confirmPIN == newPIN
        case .clear:
            return currentPIN.count == 6
        }
    }

    private func submit() {
        guard canSubmit else { return }
        errorMessage = nil

        if mode == .set || mode == .change {
            guard newPIN.count == 6, newPIN.allSatisfy({ $0.isNumber }) else {
                errorMessage = "PIN must be exactly 6 digits."
                return
            }
            guard newPIN == confirmPIN else {
                errorMessage = "PINs do not match."
                return
            }
        }

        isLoading = true
        let stream = daemonClient?.subscribe()
        Task {
            do {
                switch mode {
                case .set:
                    try daemonClient?.sendParentalControlSetPin(newPin: newPIN)
                case .change:
                    try daemonClient?.sendParentalControlChangePin(currentPin: currentPIN, newPin: newPIN)
                case .clear:
                    try daemonClient?.sendParentalControlClearPin(currentPin: currentPIN)
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
                return
            }

            let response: ParentalControlSetPinResponseMessage? = await withTaskGroup(of: ParentalControlSetPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlSetPinResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        onComplete(.success(mode))
                    } else {
                        errorMessage = r.error ?? "Operation failed."
                    }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }
}

// MARK: - Unlock Sheet

@MainActor
private struct UnlockSheet: View {
    let onComplete: (Bool) -> Void
    var daemonClient: DaemonClient?

    @State private var pin: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Unlock Parental Controls")
                .font(VFont.headline)
                .foregroundColor(VColor.textPrimary)

            Text("Enter your 6-digit PIN to unlock settings.")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            SecureField("PIN", text: $pin)
                .textFieldStyle(.roundedBorder)
                .font(VFont.body)

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }

            HStack {
                Spacer()
                VButton(label: "Cancel", style: .secondary) {
                    dismiss()
                }
                VButton(label: "Unlock", style: .primary) {
                    verify()
                }
                .disabled(isLoading || pin.count != 6)
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 280)
        .background(VColor.background)
    }

    private func verify() {
        guard pin.count == 6 else { return }
        isLoading = true
        errorMessage = nil

        let stream = daemonClient?.subscribe()
        Task {
            do {
                try daemonClient?.sendParentalControlVerifyPin(pin: pin)
            } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }

            let response: ParentalControlVerifyPinResponseMessage? = await withTaskGroup(of: ParentalControlVerifyPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await message in stream {
                        if case .parentalControlVerifyPinResponse(let msg) = message { return msg }
                    }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(nanoseconds: 8_000_000_000)
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            await MainActor.run {
                isLoading = false
                if let r = response {
                    onComplete(r.verified)
                    if !r.verified { errorMessage = "Incorrect PIN." }
                } else {
                    errorMessage = "No response from daemon."
                }
            }
        }
    }
}

// MARK: - Topic / Category enumerations

private enum ContentTopic: String, CaseIterable, Identifiable {
    case violence
    case adult_content
    case political
    case gambling
    case drugs

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .violence: return "Violence"
        case .adult_content: return "Adult Content"
        case .political: return "Political Topics"
        case .gambling: return "Gambling"
        case .drugs: return "Drugs & Controlled Substances"
        }
    }
}

private enum ToolCategory: String, CaseIterable, Identifiable {
    case computer_use
    case network
    case shell
    case file_write

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .computer_use: return "Computer Control"
        case .network: return "Web & Network"
        case .shell: return "Terminal / Shell"
        case .file_write: return "File Editing"
        }
    }

    var description: String {
        switch self {
        case .computer_use: return "Screenshots, accessibility control, mouse & keyboard."
        case .network: return "Web search, web fetch, browser navigation."
        case .shell: return "Bash commands, terminal access."
        case .file_write: return "Creating, editing, or deleting files."
        }
    }
}

// MARK: - Preview

#Preview("Parental Tab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ScrollView {
            SettingsParentalTab(daemonClient: nil)
                .padding(VSpacing.xl)
        }
    }
    .frame(width: 420, height: 600)
}
