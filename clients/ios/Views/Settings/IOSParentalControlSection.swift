#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - iOS Parental Control Settings

/// iOS settings screen for configuring parental controls on the connected
/// macOS assistant. Changes are sent to the daemon via IPC.
struct IOSParentalControlSection: View {
    @EnvironmentObject var clientProvider: ClientProvider

    @State private var isEnabled: Bool = false
    @State private var hasPIN: Bool = false
    @State private var contentRestrictions: Set<String> = []
    @State private var blockedToolCategories: Set<String> = []

    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

    @State private var showingSetPIN: Bool = false
    @State private var showingChangePIN: Bool = false
    @State private var showingClearPIN: Bool = false
    @State private var showingUnlock: Bool = false
    @State private var isUnlocked: Bool = false
    // Retained after a successful unlock so that subsequent update calls can
    // forward the PIN to the daemon (required when parental mode is enabled).
    @State private var unlockedPIN: String?

    private var daemon: DaemonClient? { clientProvider.client as? DaemonClient }

    var body: some View {
        Form {
            Section {
                HStack {
                    Text("Enable Parental Controls")
                    Spacer()
                    if isLoading {
                        ProgressView()
                    } else {
                        Toggle("", isOn: Binding(
                            get: { isEnabled },
                            set: { newValue in
                                if !newValue && isEnabled && hasPIN && !isUnlocked {
                                    showingUnlock = true
                                } else {
                                    updateEnabled(newValue)
                                }
                            }
                        ))
                        .labelsHidden()
                    }
                }
            } footer: {
                Text("Restrict content topics and tool access. Protect settings with a 6-digit PIN.")
            }

            if isEnabled {
                if isUnlocked || !hasPIN {
                    pinSection
                    contentRestrictionsSection
                    toolCategorySection
                } else {
                    Section {
                        Button("Unlock Settings") {
                            showingUnlock = true
                        }
                    } footer: {
                        Text("Enter your PIN to change parental control settings.")
                    }
                }
            }

            if let error = errorMessage {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
            if let success = successMessage {
                Section {
                    Text(success).foregroundStyle(.green)
                }
            }
        }
        .navigationTitle("Parental Controls")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { loadSettings() }
        .sheet(isPresented: $showingSetPIN) {
            IOSPINSheet(mode: .set, daemon: daemon) { result in
                showingSetPIN = false
                handlePINResult(result)
            }
        }
        .sheet(isPresented: $showingChangePIN) {
            IOSPINSheet(mode: .change, daemon: daemon) { result in
                showingChangePIN = false
                handlePINResult(result)
            }
        }
        .sheet(isPresented: $showingClearPIN) {
            IOSPINSheet(mode: .clear, daemon: daemon) { result in
                showingClearPIN = false
                handlePINResult(result)
            }
        }
        .sheet(isPresented: $showingUnlock) {
            IOSUnlockSheet(daemon: daemon) { result in
                showingUnlock = false
                switch result {
                case .success(let pin):
                    isUnlocked = true
                    unlockedPIN = pin
                    errorMessage = nil
                case .failure:
                    errorMessage = "Incorrect PIN."
                }
            }
        }
    }

    // MARK: - Sub-sections

    private var pinSection: some View {
        Section("PIN Lock") {
            if hasPIN {
                Button("Change PIN") {
                    errorMessage = nil; successMessage = nil
                    showingChangePIN = true
                }
                Button("Remove PIN", role: .destructive) {
                    errorMessage = nil; successMessage = nil
                    showingClearPIN = true
                }
            } else {
                Button("Set PIN") {
                    errorMessage = nil; successMessage = nil
                    showingSetPIN = true
                }
            }
        }
    }

    private var contentRestrictionsSection: some View {
        Section {
            ForEach(IOSContentTopic.allCases) { topic in
                Toggle(topic.displayName, isOn: Binding(
                    get: { contentRestrictions.contains(topic.rawValue) },
                    set: { enabled in
                        var updated = contentRestrictions
                        if enabled { updated.insert(topic.rawValue) } else { updated.remove(topic.rawValue) }
                        updateContentRestrictions(Array(updated))
                    }
                ))
                .disabled(isLoading)
            }
        } header: {
            Text("Content Restrictions")
        } footer: {
            Text("Block the assistant from discussing these topics.")
        }
    }

    private var toolCategorySection: some View {
        Section {
            ForEach(IOSToolCategory.allCases) { category in
                Toggle(category.displayName, isOn: Binding(
                    get: { blockedToolCategories.contains(category.rawValue) },
                    set: { blocked in
                        var updated = blockedToolCategories
                        if blocked { updated.insert(category.rawValue) } else { updated.remove(category.rawValue) }
                        updateToolCategories(Array(updated))
                    }
                ))
                .disabled(isLoading)
            }
        } header: {
            Text("Tool Restrictions")
        } footer: {
            Text("Prevent the assistant from using these categories of tools.")
        }
    }

    // MARK: - Daemon interactions

    private func loadSettings() {
        isLoading = true
        errorMessage = nil
        let stream = daemon?.subscribe()
        Task {
            do { try daemon?.sendParentalControlGet() } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlGetResponseMessage? = await withTaskGroup(of: ParentalControlGetResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlGetResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response {
                    isEnabled = r.enabled; hasPIN = r.has_pin
                    contentRestrictions = Set(r.content_restrictions)
                    blockedToolCategories = Set(r.blocked_tool_categories)
                } else { errorMessage = "No response from assistant." }
            }
        }
    }

    private func updateEnabled(_ enabled: Bool) {
        isLoading = true; errorMessage = nil; successMessage = nil
        let stream = daemon?.subscribe()
        let pin = unlockedPIN
        Task {
            do { try daemon?.sendParentalControlUpdate(pin: pin, enabled: enabled) } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlUpdateResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success {
                        isEnabled = r.enabled; hasPIN = r.has_pin
                        contentRestrictions = Set(r.content_restrictions)
                        blockedToolCategories = Set(r.blocked_tool_categories)
                    } else { errorMessage = r.error ?? "Update failed." }
                } else { errorMessage = "No response from assistant." }
            }
        }
    }

    private func updateContentRestrictions(_ restrictions: [String]) {
        isLoading = true; errorMessage = nil; successMessage = nil
        let stream = daemon?.subscribe()
        let pin = unlockedPIN
        Task {
            do { try daemon?.sendParentalControlUpdate(pin: pin, contentRestrictions: restrictions) } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlUpdateResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response, r.success {
                    contentRestrictions = Set(r.content_restrictions)
                } else { errorMessage = response?.error ?? "Update failed."; loadSettings() }
            }
        }
    }

    private func updateToolCategories(_ categories: [String]) {
        isLoading = true; errorMessage = nil; successMessage = nil
        let stream = daemon?.subscribe()
        let pin = unlockedPIN
        Task {
            do { try daemon?.sendParentalControlUpdate(pin: pin, blockedToolCategories: categories) } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlUpdateResponseMessage? = await withTaskGroup(of: ParentalControlUpdateResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlUpdateResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response, r.success {
                    blockedToolCategories = Set(r.blocked_tool_categories)
                } else { errorMessage = response?.error ?? "Update failed."; loadSettings() }
            }
        }
    }

    private func handlePINResult(_ result: IOSPINResult) {
        switch result {
        case .success(let mode):
            switch mode {
            case .set: hasPIN = true; successMessage = "PIN set."
            // The old PIN is now invalid; clear the cache so subsequent
            // updates don't silently send a stale credential.
            case .change: isUnlocked = false; unlockedPIN = nil; successMessage = "PIN changed."
            case .clear: hasPIN = false; isUnlocked = false; unlockedPIN = nil; successMessage = "PIN cleared."
            }
        case .failure(let msg):
            errorMessage = msg
        }
    }
}

// MARK: - PIN Sheet (iOS)

enum IOSPINMode { case set, change, clear }
enum IOSPINResult { case success(IOSPINMode); case failure(String) }

struct IOSPINSheet: View {
    let mode: IOSPINMode
    let daemon: DaemonClient?
    let onComplete: (IOSPINResult) -> Void

    @State private var currentPIN: String = ""
    @State private var newPIN: String = ""
    @State private var confirmPIN: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    private var title: String {
        switch mode { case .set: "Set PIN"; case .change: "Change PIN"; case .clear: "Remove PIN" }
    }

    private var canSubmit: Bool {
        switch mode {
        case .set: return newPIN.count == 6 && confirmPIN == newPIN
        case .change: return currentPIN.count == 6 && newPIN.count == 6 && confirmPIN == newPIN
        case .clear: return currentPIN.count == 6
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if mode == .change || mode == .clear {
                    Section("Current PIN") {
                        SecureField("6-digit PIN", text: $currentPIN)
                            .keyboardType(.numberPad)
                    }
                }
                if mode == .set || mode == .change {
                    Section("New PIN") {
                        SecureField("6-digit PIN", text: $newPIN)
                            .keyboardType(.numberPad)
                        SecureField("Confirm PIN", text: $confirmPIN)
                            .keyboardType(.numberPad)
                    }
                }
                if let error = errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Button("Confirm") { submit() }.disabled(!canSubmit)
                    }
                }
            }
        }
    }

    private func submit() {
        guard canSubmit else { return }
        if (mode == .set || mode == .change), newPIN != confirmPIN {
            errorMessage = "PINs do not match."; return
        }
        isLoading = true; errorMessage = nil
        let stream = daemon?.subscribe()
        Task {
            do {
                switch mode {
                case .set: try daemon?.sendParentalControlSetPin(newPin: newPIN)
                case .change: try daemon?.sendParentalControlChangePin(currentPin: currentPIN, newPin: newPIN)
                case .clear: try daemon?.sendParentalControlClearPin(currentPin: currentPIN)
                }
            } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlSetPinResponseMessage? = await withTaskGroup(of: ParentalControlSetPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlSetPinResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.success { onComplete(.success(mode)) }
                    else { errorMessage = r.error ?? "Operation failed." }
                } else { errorMessage = "No response from assistant." }
            }
        }
    }
}

// MARK: - Unlock Sheet (iOS)

enum IOSUnlockResult { case success(pin: String); case failure }

struct IOSUnlockSheet: View {
    let daemon: DaemonClient?
    let onComplete: (IOSUnlockResult) -> Void

    @State private var pin: String = ""
    @State private var isLoading: Bool = false
    @State private var errorMessage: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Enter PIN") {
                    SecureField("6-digit PIN", text: $pin)
                        .keyboardType(.numberPad)
                }
                if let error = errorMessage {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Unlock Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Button("Unlock") { verify() }.disabled(pin.count != 6)
                    }
                }
            }
        }
    }

    private func verify() {
        guard pin.count == 6 else { return }
        isLoading = true; errorMessage = nil
        let stream = daemon?.subscribe()
        Task {
            do { try daemon?.sendParentalControlVerifyPin(pin: pin) } catch {
                await MainActor.run { isLoading = false; errorMessage = error.localizedDescription }
                return
            }
            let response: ParentalControlVerifyPinResponseMessage? = await withTaskGroup(of: ParentalControlVerifyPinResponseMessage?.self) { group in
                group.addTask {
                    guard let stream else { return nil }
                    for await msg in stream { if case .parentalControlVerifyPinResponse(let r) = msg { return r } }
                    return nil
                }
                group.addTask { try? await Task.sleep(nanoseconds: 8_000_000_000); return nil }
                let first = await group.next() ?? nil; group.cancelAll(); return first
            }
            await MainActor.run {
                isLoading = false
                if let r = response {
                    if r.verified { onComplete(.success(pin: pin)) }
                    else { onComplete(.failure); errorMessage = "Incorrect PIN." }
                } else { errorMessage = "No response from assistant." }
            }
        }
    }
}

// MARK: - Topic / Category enumerations

private enum IOSContentTopic: String, CaseIterable, Identifiable {
    case violence, adult_content, political, gambling, drugs
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .violence: "Violence"
        case .adult_content: "Adult Content"
        case .political: "Political Topics"
        case .gambling: "Gambling"
        case .drugs: "Drugs & Controlled Substances"
        }
    }
}

private enum IOSToolCategory: String, CaseIterable, Identifiable {
    case computer_use, network, shell, file_write
    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .computer_use: "Computer Control"
        case .network: "Web & Network"
        case .shell: "Terminal / Shell"
        case .file_write: "File Editing"
        }
    }
}

#endif
