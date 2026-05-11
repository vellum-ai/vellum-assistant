import SwiftUI
import VellumAssistantShared

/// Management sheet for the user's provider connections. Lists every entry
/// returned by `GET /v1/inference/provider-connections`, surfaces a provider
/// chip and auth-type badge per row, and exposes Edit / Delete per row plus
/// a "+ New Connection" toolbar action.
///
/// State ownership: connections are fetched lazily from the daemon on sheet
/// open and after every mutation. They live in local `@State` so the main
/// `SettingsStore` does not need to be extended for a purely transient list.
@MainActor
struct ProvidersSheet: View {
    @ObservedObject var store: SettingsStore
    @Binding var isPresented: Bool
    var client: ProviderConnectionClientProtocol

    @State private var connections: [ProviderConnection] = []
    @State private var editorState: EditorState?
    @State private var editorDraft = ConnectionDraft()
    @State private var isKeyDirty = false
    @State private var conflictInfo: ConflictInfo?
    @State private var actionError: String?

    /// Masked value of the currently-selected credential (e.g. "sk-ant-api...Ab1x").
    @State private var maskedCredentialValue: String?

    /// Whether the credential value is being loaded from the daemon.
    @State private var isLoadingCredential = false

    /// Available credentials for the current provider (for the Advanced dropdown).
    @State private var availableCredentials: [(service: String, field: String)] = []

    /// Whether the "create new credential" inline form is showing.
    @State private var isCreatingNewCredential = false

    /// Name for a new credential being created.
    @State private var newCredentialName = ""

    /// Tracks the in-flight `loadMaskedValue` task so a newer lookup cancels
    /// the older one. Prevents a stale response from clobbering the value
    /// that matches the user's current credential selection.
    @State private var loadMaskedTask: Task<Void, Never>?

    /// Connection names with an in-flight status PATCH from the inline row
    /// toggle. Used to drop subsequent toggle attempts so a fast off→on→off
    /// sequence can't produce out-of-order responses that clobber the user's
    /// final intent.
    @State private var inFlightStatusToggles: Set<String> = []

    // MARK: - Nested Types

    struct ConnectionDraft {
        var name = ""
        var label = ""
        var provider = ""
        var authType = "api_key"
        var credential = ""
        var status: ConnectionStatus = .active
        // Inline credential editing
        var apiKeyValue = ""
        var isAdvancedExpanded = false
    }

    enum EditorState {
        case create
        case edit(name: String)
        /// Opened for connections whose `isManaged` flag is true (the daemon
        /// sets this for the canonical anthropic-managed / openai-managed /
        /// gemini-managed rows). The daemon write-protects DELETE + PATCH-auth
        /// on these rows. The UI mirrors that by disabling the auth-related
        /// fields (Auth Type, API Key, Advanced/Credential Reference) but
        /// leaves Display Name + Status editable — those are exactly the
        /// PATCH fields the daemon allows on managed rows.
        case managedEdit(name: String)
    }

    /// True when the editor is in managed-edit mode. Selectively disables the
    /// auth-related fields (Auth Type, API Key, Credential Reference) while
    /// leaving Display Name + Status editable.
    private var isAuthLocked: Bool {
        if case .managedEdit = editorState { return true }
        return false
    }

    struct ConflictInfo: Identifiable {
        let id = UUID()
        let connectionName: String
        let referencedBy: [String]
    }

    // MARK: - Init

    init(
        store: SettingsStore,
        isPresented: Binding<Bool>,
        client: ProviderConnectionClientProtocol = ProviderConnectionClient()
    ) {
        self.store = store
        self._isPresented = isPresented
        self.client = client
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if editorState != nil {
                editorInline
            } else {
                header
                SettingsDivider()
                connectionsList
                SettingsDivider()
                footer
            }
        }
        .frame(width: 560, height: 600)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .sheet(item: $conflictInfo) { info in
            conflictSheet(info)
        }
        .task { await refresh() }
        .onChange(of: editorState) { _, newValue in
            if newValue == nil {
                editorDraft = ConnectionDraft()
                isKeyDirty = false
                maskedCredentialValue = nil
                isLoadingCredential = false
                availableCredentials = []
                isCreatingNewCredential = false
                newCredentialName = ""
                loadMaskedTask?.cancel()
                loadMaskedTask = nil
            }
        }
        .animation(VAnimation.fast, value: editorState != nil)
    }

    // MARK: - Refresh

    private func refresh() async {
        if let fetched = await client.listProviderConnections(provider: nil) {
            connections = fetched
        } else {
            actionError = "Couldn't load connections. Please try again."
        }
    }

    // MARK: - Header / Footer

    private var header: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Provider Connections")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                Text("Connect LLM providers using API keys or platform credentials.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            VButton(
                label: "Close",
                iconOnly: VIcon.x.rawValue,
                style: .ghost,
                tintColor: VColor.contentTertiary
            ) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    private var footer: some View {
        HStack {
            VButton(label: "+ New Connection", style: .primary) {
                beginCreate()
            }
            if let actionError {
                Text(actionError)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
            Spacer()
            VButton(label: "Done", style: .outlined) {
                isPresented = false
            }
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Connections List

    private var connectionsList: some View {
        List {
            if connections.isEmpty {
                emptyState
                    .listRowSeparator(.hidden)
            } else {
                ForEach(connections, id: \.name) { conn in
                    connectionRow(conn)
                }
            }
        }
        .listStyle(.inset)
        .frame(maxHeight: .infinity)
    }

    private var emptyState: some View {
        VStack(alignment: .center, spacing: VSpacing.sm) {
            Text("No provider connections")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
            Text("Add a connection to link an LLM provider using your own API key or platform credentials.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity)
        .padding(VSpacing.xl)
    }

    private func connectionRow(_ conn: ProviderConnection) -> some View {
        let isManaged = conn.isManaged
        let isDisabled = conn.status == .disabled
        return HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                if let label = conn.label, !label.isEmpty {
                    Text(label)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    // No leading "@" on the connection key — the chip strip
                    // already groups it next to the provider + auth metadata,
                    // and the prefix made the key look like a handle when
                    // it's just an internal identifier.
                    connectionRowMetadata(conn, primary: conn.name)
                } else {
                    Text(conn.name)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    connectionRowMetadata(conn, primary: nil)
                }
            }
            .opacity(isDisabled ? 0.55 : 1.0)
            Spacer(minLength: 0)
            HStack(spacing: VSpacing.sm) {
                VToggle(
                    isOn: Binding(
                        get: { conn.status == .active },
                        set: { newActive in
                            Task { await setStatus(conn, active: newActive) }
                        }
                    )
                )
                .accessibilityLabel("\(isDisabled ? "Activate" : "Disable") connection \(conn.label?.isEmpty == false ? conn.label! : conn.name)")
                .help(isDisabled ? "Disabled — toggle to activate" : "Active — toggle to disable")
                VButton(label: "Edit", style: .ghost) {
                    if isManaged {
                        beginManagedEdit(conn)
                    } else {
                        beginEdit(conn)
                    }
                }
                VButton(label: "Delete", style: .ghost) {
                    Task { await attemptDelete(conn.name) }
                }
                .disabled(isManaged)
                .help(isManaged ? "Managed connections cannot be deleted" : "")
            }
        }
        .padding(.vertical, VSpacing.xs)
        .contentShape(Rectangle())
    }

    /// The chip strip rendered under the connection name. Pulled out so the
    /// label-present and label-absent branches share one source of truth for
    /// what metadata appears (and in what order). `primary`, if non-nil, is
    /// shown as the first chip (used for `@key` when a label takes the
    /// primary slot).
    private func connectionRowMetadata(_ conn: ProviderConnection, primary: String?) -> some View {
        HStack(spacing: VSpacing.xs) {
            if let primary {
                Text(primary)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            if conn.isManaged {
                VBadge(label: "Vellum", tone: .neutral, emphasis: .subtle)
                    .help("Managed by Vellum — auth is locked, but you can rename or disable this connection.")
            }
            VBadge(
                label: store.dynamicProviderDisplayName(conn.provider),
                tone: .neutral,
                emphasis: .subtle
            )
            VBadge(
                label: authTypeLabel(conn.auth.type),
                tone: authTypeTone(conn.auth.type),
                emphasis: .subtle
            )
        }
    }

    private func authTypeLabel(_ type: String) -> String {
        switch type {
        case "api_key": return "API Key"
        case "platform": return "Platform"
        case "none": return "None"
        case "oauth_subscription": return "OAuth"
        case "service_account": return "Service Account"
        default: return type
        }
    }

    private func authTypeTone(_ type: String) -> VBadge.Tone {
        type == "platform" ? .positive : .neutral
    }

    // MARK: - Inline Editor

    private var editorInline: some View {
        VStack(spacing: 0) {
            editorHeader
            SettingsDivider()
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    editorLabelField
                    editorKeyField
                    if case .create = editorState {
                        editorProviderField
                    }
                    Group {
                        editorAuthTypeField
                        if editorDraft.authType == "api_key" {
                            editorApiKeyField
                            // Note: Advanced disclosure is gated by
                            // `shouldShowAdvancedSection` and only renders
                            // once at least one credential exists for the
                            // provider (or the user is mid-create). In the
                            // empty state, the plain `editorApiKeyField`
                            // above is the path: saving auto-creates
                            // `credential/<provider>/api_key`. This is a
                            // deliberate simplification (provider-conn UX
                            // iter2, item 6) — users who want a *named*
                            // credential save first with the default ref,
                            // then re-open the editor to use Advanced.
                            // This supersedes the earlier "keep Advanced
                            // visible always" guidance from PR #30294.
                            editorAdvancedSection
                        } else if editorDraft.authType == "platform" {
                            editorPlatformNote
                        } else if editorDraft.authType == "none" {
                            editorNoneNote
                        }
                    }
                    .disabled(isAuthLocked)
                    editorStatusToggle
                    if let actionError {
                        Text(actionError)
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.systemNegativeStrong)
                    }
                }
                .padding(VSpacing.lg)
            }
            SettingsDivider()
            editorFooter
        }
        .onChange(of: editorDraft.provider) { _, newProvider in
            if case .create = editorState, !newProvider.isEmpty {
                editorDraft.credential = "credential/\(newProvider)/api_key"
                maskedCredentialValue = nil
                Task { await loadAvailableCredentials() }
            }
        }
    }

    private var editorHeader: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            let title: String = {
                switch editorState {
                case .create: return "New Connection"
                case .edit(let name): return "Edit \"\(name)\""
                case .managedEdit(let name): return "Edit \"\(name)\""
                case nil: return ""
                }
            }()
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                if isAuthLocked {
                    Text("Managed by Vellum — auth is locked, but you can rename or disable this connection.")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            Spacer(minLength: 0)
            VButton(
                label: "Cancel",
                style: .ghost,
                tintColor: VColor.contentTertiary
            ) {
                editorState = nil
                actionError = nil
            }
        }
        .padding(VSpacing.lg)
    }

    private var editorLabelField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Display Name")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextField(
                placeholder: "e.g. My OpenAI",
                text: Binding(
                    get: { editorDraft.label },
                    set: { newValue in
                        editorDraft.label = newValue
                        if !isKeyDirty {
                            editorDraft.name = InferenceProfileEditor.toKebabCase(newValue)
                        }
                    }
                )
            )
        }
    }

    private var editorKeyField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Key")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextField(
                placeholder: "my-connection",
                text: Binding(
                    get: { editorDraft.name },
                    set: { newValue in
                        isKeyDirty = true
                        editorDraft.name = newValue
                    }
                )
            )
            .disabled(editorState != .create)
        }
    }

    private var editorStatusToggle: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Status")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VToggle(
                isOn: Binding(
                    get: { editorDraft.status == .active },
                    set: { editorDraft.status = $0 ? .active : .disabled }
                ),
                label: "Active"
            )
        }
    }

    private var editorProviderField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Provider")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $editorDraft.provider,
                options: store.providerCatalog.map { (label: $0.displayName, value: $0.id) }
            )
        }
    }

    private var editorAuthTypeField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Auth Type")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select auth type\u{2026}",
                selection: $editorDraft.authType,
                options: [
                    (label: "API Key", value: "api_key"),
                    (label: "Platform (managed by Vellum)", value: "platform"),
                    (label: "None (no credentials)", value: "none"),
                ]
            )
        }
    }

    private var editorApiKeyField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("API Key")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)

            if isLoadingCredential {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading...")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(height: 32)
            } else {
                VTextField(
                    placeholder: maskedCredentialValue ?? "Enter your API key",
                    text: $editorDraft.apiKeyValue,
                    isSecure: true
                )
            }

            if maskedCredentialValue != nil && editorDraft.apiKeyValue.isEmpty {
                Text("A key is configured. Enter a new value to replace it.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    /// Whether the Advanced disclosure (credential picker + "New Credential"
    /// CTA) should render. Only shows when there's at least one credential
    /// already stored for the provider, OR when the user is mid-create. In
    /// the empty state the API Key field above is the only path needed —
    /// saving a key auto-creates `credential/<provider>/api_key`, so the
    /// disclosure has nothing meaningful to offer.
    private var shouldShowAdvancedSection: Bool {
        let providerCredentials = availableCredentials.filter { $0.service == editorDraft.provider }
        return !providerCredentials.isEmpty || isCreatingNewCredential
    }

    @ViewBuilder
    private var editorAdvancedSection: some View {
        if shouldShowAdvancedSection {
            VDisclosureSection(
                title: "Advanced",
                subtitle: "Credential reference",
                isExpanded: $editorDraft.isAdvancedExpanded
            ) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Credential Reference")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    let options = credentialDropdownOptions
                    if !options.isEmpty {
                        VDropdown(
                            placeholder: "Select a credential\u{2026}",
                            selection: $editorDraft.credential,
                            options: options,
                            menuWidth: 360,
                            onChange: { newValue in
                                Task { await loadMaskedValue(for: newValue) }
                            }
                        )
                    }

                    if isCreatingNewCredential {
                        newCredentialForm
                    }

                    // Sticky footer: Create new credential button
                    HStack {
                        Spacer()
                        VButton(
                            label: isCreatingNewCredential ? "Cancel" : "+ New Credential",
                            style: .ghost,
                            size: .compact
                        ) {
                            if isCreatingNewCredential {
                                isCreatingNewCredential = false
                                newCredentialName = ""
                            } else {
                                isCreatingNewCredential = true
                            }
                        }
                    }
                }
            }
        }
    }

    private var newCredentialForm: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("New Credential Name")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            HStack(spacing: VSpacing.sm) {
                VTextField(
                    placeholder: "e.g. team-key",
                    text: $newCredentialName
                )
                VButton(label: "Use", style: .primary, size: .compact) {
                    let trimmed = newCredentialName.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    let ref = "credential/\(editorDraft.provider)/\(trimmed)"
                    editorDraft.credential = ref
                    isCreatingNewCredential = false
                    newCredentialName = ""
                    Task { await loadMaskedValue(for: ref) }
                }
                .disabled(newCredentialName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private var credentialDropdownOptions: [(label: String, value: String)] {
        let providerCredentials = availableCredentials.filter { $0.service == editorDraft.provider }
        return providerCredentials.map { cred in
            let ref = "credential/\(cred.service)/\(cred.field)"
            return (label: ref, value: ref)
        }
    }

    private func loadMaskedValue(for credentialRef: String) async {
        loadMaskedTask?.cancel()
        let task = Task { @MainActor in
            let parts = credentialRef.split(separator: "/")
            guard parts.count >= 3, parts[0] == "credential" else {
                maskedCredentialValue = nil
                isLoadingCredential = false
                return
            }
            let service = String(parts[1])
            let field = parts[2...].joined(separator: "/")

            isLoadingCredential = true
            let masked = await APIKeyManager.maskedCredential(service: service, field: field)
            // A newer load may have started while we awaited the network call;
            // skip writing stale results so the UI matches the latest selection.
            guard !Task.isCancelled else { return }
            maskedCredentialValue = masked
            isLoadingCredential = false
        }
        loadMaskedTask = task
        _ = await task.value
    }

    private func loadAvailableCredentials() async {
        if let creds = await APIKeyManager.listCredentials() {
            availableCredentials = creds
        }
    }

    private var editorPlatformNote: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.info, size: 16)
                .foregroundStyle(VColor.contentSecondary)
            Text("Managed by Vellum — no additional credentials required.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private var editorNoneNote: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.info, size: 16)
                .foregroundStyle(VColor.contentSecondary)
            Text("No authentication required — the provider handles access locally.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private var editorFooter: some View {
        HStack {
            Spacer()
            VButton(label: "Cancel", style: .outlined) {
                editorState = nil
                actionError = nil
            }
            VButton(label: "Save", style: .primary) {
                Task { await commitEditor() }
            }
        }
        .padding(VSpacing.lg)
    }

    // MARK: - Conflict Sheet

    private func conflictSheet(_ info: ConflictInfo) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("Can't Delete Connection")
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                let count = info.referencedBy.count
                Text("\"\(info.connectionName)\" is referenced by \(count) \(count == 1 ? "item" : "items"). Clear the references first, then delete.")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !info.referencedBy.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Referenced by:")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    ForEach(info.referencedBy, id: \.self) { ref in
                        Text("• \(ref)")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentDefault)
                    }
                }
            }
            HStack {
                Spacer()
                VButton(label: "OK", style: .primary) {
                    conflictInfo = nil
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 460)
        .background(VColor.surfaceOverlay)
    }

    // MARK: - Actions

    private func beginCreate() {
        actionError = nil
        isKeyDirty = false
        let provider = store.providerCatalog.first?.id ?? ""
        editorDraft = ConnectionDraft(
            provider: provider
        )
        if !provider.isEmpty {
            editorDraft.credential = "credential/\(provider)/api_key"
        }
        editorState = .create
        maskedCredentialValue = nil
        Task { await loadAvailableCredentials() }
    }

    private func beginEdit(_ conn: ProviderConnection) {
        actionError = nil
        isKeyDirty = true
        editorDraft = ConnectionDraft(
            name: conn.name,
            label: conn.label ?? "",
            provider: conn.provider,
            authType: conn.auth.type,
            credential: conn.auth.credential ?? "",
            status: conn.status
        )
        editorState = .edit(name: conn.name)

        if conn.auth.type == "api_key", let credential = conn.auth.credential, !credential.isEmpty {
            Task {
                await loadMaskedValue(for: credential)
                await loadAvailableCredentials()
            }
        }
    }

    /// Open the editor for a Vellum-managed connection. Auth-related fields
    /// (Auth Type, API Key, Credential Reference) are disabled via
    /// `isAuthLocked` so the daemon's write-protection on `auth` for managed
    /// rows isn't surprising; Display Name + Status remain editable to match
    /// what the daemon allows on managed PATCHes.
    private func beginManagedEdit(_ conn: ProviderConnection) {
        actionError = nil
        isKeyDirty = true
        editorDraft = ConnectionDraft(
            name: conn.name,
            label: conn.label ?? "",
            provider: conn.provider,
            authType: conn.auth.type,
            credential: conn.auth.credential ?? "",
            status: conn.status
        )
        editorState = .managedEdit(name: conn.name)

        if conn.auth.type == "api_key", let credential = conn.auth.credential, !credential.isEmpty {
            Task {
                await loadMaskedValue(for: credential)
                await loadAvailableCredentials()
            }
        }
    }

    /// Inline status toggle from the list row. Optimistically updates the
    /// row, PATCHes the daemon with just the new status (auth + label stay
    /// untouched), and rolls back on failure. Mirrors the daemon's accept-
    /// status-only PATCH path so managed connections can be toggled too.
    ///
    /// `inFlightStatusToggles` guards against overlapping toggles for the
    /// same row — a fast off→on→off sequence would otherwise produce
    /// out-of-order PATCH responses that clobber the user's final intent.
    private func setStatus(_ conn: ProviderConnection, active: Bool) async {
        guard !inFlightStatusToggles.contains(conn.name) else { return }
        let newStatus: ConnectionStatus = active ? .active : .disabled
        let previous = conn.status
        inFlightStatusToggles.insert(conn.name)
        defer { inFlightStatusToggles.remove(conn.name) }

        // Optimistic update — `ProviderConnection` is an immutable struct,
        // so swap in a new value with just `status` flipped.
        if let idx = connections.firstIndex(where: { $0.name == conn.name }) {
            connections[idx] = conn.withStatus(newStatus)
        }
        guard let updated = await client.updateProviderConnection(
            name: conn.name,
            auth: conn.auth,
            status: newStatus,
            label: .none
        ) else {
            // Roll back on failure.
            if let idx = connections.firstIndex(where: { $0.name == conn.name }) {
                connections[idx] = conn.withStatus(previous)
            }
            actionError = "Couldn't update \"\(conn.name)\". Please try again."
            return
        }
        if let idx = connections.firstIndex(where: { $0.name == conn.name }) {
            connections[idx] = updated
        }
    }

    private func commitEditor() async {
        actionError = nil
        let draft = editorDraft
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionError = "Name is required."
            return
        }

        var credentialRef = draft.credential.trimmingCharacters(in: .whitespacesAndNewlines)

        if draft.authType == "api_key" {
            if credentialRef.isEmpty {
                credentialRef = "credential/\(draft.provider)/api_key"
            }

            let trimmedKey = draft.apiKeyValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedKey.isEmpty {
                let parts = credentialRef.split(separator: "/")
                let result: APIKeyManager.SetKeyResult
                if parts.count >= 3 && parts[0] == "credential" {
                    let service = String(parts[1])
                    let field = parts[2...].joined(separator: "/")
                    result = await APIKeyManager.setCredential(trimmedKey, service: service, field: field)
                } else {
                    result = await APIKeyManager.setKey(trimmedKey, for: draft.provider)
                }

                if !result.success {
                    actionError = result.error ?? "Failed to save API key."
                    return
                }
            } else if maskedCredentialValue == nil {
                // Block save when there's no new key AND no existing credential to
                // reference — applies to both create and edit (e.g. switching
                // platform→api_key without supplying a value). Existing api_key
                // edits hit this branch with maskedCredentialValue set (loaded by
                // beginEdit), so a save-without-change still succeeds.
                actionError = "Enter an API key or select an existing credential."
                return
            }
        }

        let auth = ProviderConnectionAuth(
            type: draft.authType,
            credential: draft.authType == "api_key" ? credentialRef : nil
        )
        let label: String? = draft.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = draft.status

        switch editorState {
        case .create:
            guard let created = await client.createProviderConnection(
                name: name,
                provider: draft.provider,
                auth: auth,
                label: label,
                status: status
            ) else {
                actionError = "Couldn't create connection. Please try again."
                return
            }
            connections.append(created)
            editorState = nil

        case .edit(let originalName), .managedEdit(let originalName):
            // Managed-edit and user-edit share the same PATCH path. The auth
            // fields are locked in the UI for managed connections, so the
            // draft's authType/credential haven't changed; if a user
            // somehow bypassed that, the daemon enforces the same
            // write-protection and returns a 400 we surface as actionError.
            guard let updated = await client.updateProviderConnection(
                name: originalName,
                auth: auth,
                status: status,
                label: .some(label)
            ) else {
                await refresh()
                actionError = "Couldn't update connection. List refreshed."
                editorState = nil
                return
            }
            if let idx = connections.firstIndex(where: { $0.name == originalName }) {
                connections[idx] = updated
            }
            editorState = nil

        case nil:
            break
        }
    }

    private func attemptDelete(_ name: String) async {
        actionError = nil
        let result = await client.deleteProviderConnection(name: name)
        switch result {
        case .deleted:
            connections.removeAll { $0.name == name }
        case .notFound:
            await refresh()
            actionError = "Connection \"\(name)\" no longer exists. List refreshed."
        case .conflict(let referencedBy):
            conflictInfo = ConflictInfo(connectionName: name, referencedBy: referencedBy)
        case .error:
            actionError = "Couldn't delete \"\(name)\". Please try again."
        }
    }
}

// MARK: - EditorState Equatable

extension ProvidersSheet.EditorState: Equatable {}
