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
    var assistantFeatureFlagStore: AssistantFeatureFlagStore?

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

    // -- ChatGPT Subscription OAuth state -----------------------------------

    enum ChatgptOAuthState {
        case idle, starting, pasteUrl, exchanging, completed, failed
    }

    @State private var chatgptOAuthState: ChatgptOAuthState = .idle
    @State private var chatgptPastedUrl = ""
    @State private var chatgptOAuthError: String?
    @State private var chatgptOAuthStoredState = ""

    /// True when the ChatGPT subscription OAuth section should be visible:
    /// feature flag enabled, provider is "openai", and either we're in create
    /// mode (new connection) or editing an existing oauth_subscription
    /// connection (so the user can re-authenticate if needed).
    private var isChatgptSubscriptionVisible: Bool {
        guard editorDraft.provider == "openai" else {
            return false
        }
        switch editorState {
        case .create:
            return true
        case .edit, .managedEdit:
            return editorDraft.authType == "oauth_subscription"
        case .none:
            return false
        }
    }

    // MARK: - Nested Types

    struct ConnectionDraft {
        var name = ""
        var label = ""
        var provider = ""
        var authType = "api_key"
        var credential = ""
        // Inline credential editing
        var apiKeyValue = ""
        var isAdvancedExpanded = false
        // OpenAI-compatible fields
        var baseUrl = ""
        var connectionModels = ""

        var isOpenAICompatible: Bool { provider == "openai-compatible" }
    }

    enum EditorState {
        case create
        case edit(name: String)
        /// Opened for connections whose `isManaged` flag is true (the daemon
        /// sets this for the canonical anthropic-managed / openai-managed /
        /// gemini-managed rows). The daemon write-protects DELETE + PATCH-auth
        /// on these rows. The UI mirrors that by disabling the auth-related
        /// fields (Auth Type, API Key, Advanced/Credential Reference) but
        /// leaves Display Name editable — that is exactly the PATCH field
        /// the daemon allows on managed rows.
        case managedEdit(name: String)
    }

    /// True when the editor is in managed-edit mode. Selectively disables the
    /// auth-related fields (Auth Type, API Key, Credential Reference) while
    /// leaving Display Name editable.
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
        client: ProviderConnectionClientProtocol = ProviderConnectionClient(),
        assistantFeatureFlagStore: AssistantFeatureFlagStore? = nil
    ) {
        self.store = store
        self._isPresented = isPresented
        self.client = client
        self.assistantFeatureFlagStore = assistantFeatureFlagStore
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
                // Reset ChatGPT OAuth state
                chatgptOAuthState = .idle
                chatgptPastedUrl = ""
                chatgptOAuthError = nil
                chatgptOAuthStoredState = ""
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
            Spacer(minLength: 0)
            HStack(spacing: VSpacing.sm) {
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
                VBadge(label: "Platform", tone: .positive, emphasis: .subtle)
                    .help("Managed by Platform — auth is locked, but you can rename this connection.")
            }
            VBadge(
                label: store.dynamicProviderDisplayName(conn.provider),
                tone: .neutral,
                emphasis: .subtle
            )
            if !(conn.isManaged && conn.auth.type == "platform") {
                VBadge(
                    label: authTypeLabel(conn.auth.type),
                    tone: authTypeTone(conn.auth.type),
                    emphasis: .subtle
                )
            }
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
                    if editorDraft.isOpenAICompatible {
                        editorBaseUrlField
                        editorModelsField
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
                        } else if editorDraft.authType == "oauth_subscription" {
                            editorOAuthSubscriptionNote
                            if isChatgptSubscriptionVisible {
                                chatgptSubscriptionSection
                            }
                        }
                    }
                    .disabled(isAuthLocked)
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
                if newProvider == "ollama" {
                    editorDraft.authType = "none"
                    editorDraft.credential = ""
                } else {
                    if editorDraft.authType == "none" ||
                        (editorDraft.authType == "platform" && !store.isPlatformCapable(newProvider)) {
                        editorDraft.authType = "api_key"
                    }
                    editorDraft.credential = "credential/\(newProvider)/api_key"
                }
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
                    Text("Managed by Vellum — auth is locked, but you can rename this connection.")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
            Spacer(minLength: 0)
            VButton(
                label: "Close",
                iconOnly: VIcon.x.rawValue,
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

    private var editorProviderField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.xs) {
                Text("Provider")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                // Warning badge — only renders in create mode while the
                // dropdown is still empty. Edit mode pins the value to the
                // connection's saved provider (the dropdown is disabled in
                // that path), so `isProviderMissing` can never trip there.
                if isProviderMissing {
                    VBadge(label: "Pick a provider", tone: .warning, emphasis: .subtle)
                }
            }
            VDropdown(
                placeholder: "Select a provider\u{2026}",
                selection: $editorDraft.provider,
                options: store.providerCatalog.map { (label: $0.displayName, value: $0.id) }
            )
        }
    }

    private var editorBaseUrlField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Base URL")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextField(
                placeholder: "https://api.example.com/v1",
                text: $editorDraft.baseUrl
            )
            .disabled(isAuthLocked)
        }
    }

    private var editorModelsField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Models")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextField(
                placeholder: "model-1, model-2",
                text: $editorDraft.connectionModels
            )
            .disabled(isAuthLocked)
            Text("Comma-separated model identifiers exposed by your endpoint.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    private var authTypeOptions: [(label: String, value: String)] {
        let provider = editorDraft.provider
        if provider == "ollama" {
            return [(label: "None (no credentials)", value: "none")]
        }
        var options: [(label: String, value: String)] = [
            (label: "API Key", value: "api_key"),
        ]
        if store.isPlatformCapable(provider) {
            options.append((label: "Platform (managed by Vellum)", value: "platform"))
        }
        if provider == "openai" {
            options.append((label: "ChatGPT Subscription", value: "oauth_subscription"))
        }
        // Preserve the current auth type in edit mode so existing connections
        // display their saved value even if the type is no longer offered for
        // new connections (e.g. a non-ollama connection with "none" auth).
        let current = editorDraft.authType
        if !current.isEmpty && !options.contains(where: { $0.value == current }) {
            let label: String = switch current {
            case "none": "None (no credentials)"
            case "platform": "Platform (managed by Vellum)"
            case "api_key": "API Key"
            case "oauth_subscription": "ChatGPT Subscription"
            default: current
            }
            options.append((label: label, value: current))
        }
        return options
    }

    private var editorAuthTypeField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Auth Type")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VDropdown(
                placeholder: "Select auth type\u{2026}",
                selection: $editorDraft.authType,
                options: authTypeOptions
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

    private var editorOAuthSubscriptionNote: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.info, size: 16)
                .foregroundStyle(VColor.contentSecondary)
            Text("Authenticated via ChatGPT subscription — no API key required.")
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
            // Save as New: only offered for managed connections. Clones the
            // row's provider + label into a fresh create-mode session where
            // the user supplies their own credential. Hidden for plain
            // edit/create because the "rename/clone unmanaged row" workflow
            // is just delete + create, and create mode already lets the
            // user pick provider + label from scratch. Mirrors web PR #6525.
            if isAuthLocked {
                VButton(label: "Save as New", style: .outlined) {
                    saveAsNewFromManagedEdit()
                }
            }
            VButton(label: editorPrimaryLabel, style: .primary, isDisabled: !canSave) {
                Task { await commitEditor() }
            }
        }
        .padding(VSpacing.lg)
    }

    /// Primary footer button label. Returns "Create" in create mode (genuine
    /// new connection OR post-Save-as-New transition out of managed-edit);
    /// "Save" everywhere else. Mirrors the web editor's
    /// `mode === "create" ? "Create" : "Save"` so the verb matches what the
    /// next click actually does.
    private var editorPrimaryLabel: String {
        switch editorState {
        case .create: return "Create"
        case .edit, .managedEdit, .none: return "Save"
        }
    }

    // MARK: - ChatGPT Subscription OAuth

    /// Bordered section for the ChatGPT subscription copy-paste PKCE flow.
    /// Visible when `isChatgptSubscriptionVisible` is true (feature flag +
    /// provider=openai + create mode). Mirrors the web UI's bordered section
    /// in `provider-editor-modal.tsx`.
    @ViewBuilder
    private var chatgptSubscriptionSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("ChatGPT Subscription")
                .font(VFont.bodyMediumEmphasised)
                .foregroundStyle(VColor.contentDefault)
            Text("Connect your ChatGPT subscription to use OpenAI models without an API key.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)

            switch chatgptOAuthState {
            case .idle:
                VButton(label: "Sign in with ChatGPT", style: .outlined, size: .compact) {
                    Task { await handleChatgptSignIn() }
                }

            case .starting:
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Starting sign-in...")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(height: 32)

            case .pasteUrl:
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        Text("1. Sign in with ChatGPT in the browser")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        Text("2. After sign-in, you'll see an error page")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                        Text("3. Copy the URL from the address bar and paste it below")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }
                    VTextField(
                        placeholder: "Paste callback URL here...",
                        text: Binding(
                            get: { chatgptPastedUrl },
                            set: { newValue in
                                chatgptPastedUrl = newValue
                                chatgptOAuthError = nil
                            }
                        )
                    )
                    HStack {
                        Spacer()
                        VButton(
                            label: "Complete Sign In",
                            style: .primary,
                            size: .compact,
                            isDisabled: chatgptPastedUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ) {
                            Task { await handleChatgptUrlSubmit() }
                        }
                    }
                }

            case .exchanging:
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Completing sign-in...")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .frame(height: 32)

            case .completed:
                Text("ChatGPT subscription connected successfully.")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemPositiveStrong)

            case .failed:
                VButton(label: "Try Again", style: .outlined, size: .compact) {
                    chatgptOAuthState = .idle
                    chatgptPastedUrl = ""
                    chatgptOAuthError = nil
                }
            }

            if let chatgptOAuthError {
                Text(chatgptOAuthError)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(VSpacing.md)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    /// Start the ChatGPT subscription OAuth flow: call the daemon, open the
    /// authorize URL in the default browser, and transition to the paste-URL
    /// state.
    private func handleChatgptSignIn() async {
        chatgptOAuthState = .starting
        chatgptOAuthError = nil
        guard let result = await client.startChatgptSubscriptionAuth() else {
            chatgptOAuthState = .failed
            chatgptOAuthError = "Failed to start ChatGPT sign-in. Please try again."
            return
        }
        chatgptOAuthStoredState = result.state
        if let url = URL(string: result.authorizeUrl) {
            NSWorkspace.shared.open(url)
        }
        chatgptOAuthState = .pasteUrl
    }

    /// Extract `code` and `state` from the pasted callback URL and exchange
    /// them for tokens via the daemon. On success, find the newly-created
    /// connection and dismiss the editor.
    private func handleChatgptUrlSubmit() async {
        chatgptOAuthError = nil
        let trimmed = chatgptPastedUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            chatgptOAuthError = "Please paste the URL from the error page."
            return
        }
        guard let components = URLComponents(string: trimmed) else {
            chatgptOAuthError = "Invalid URL. Please paste the full URL from the address bar."
            return
        }
        guard let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
            chatgptOAuthError = "The URL is missing the authorization code. Make sure you copied the full URL."
            return
        }
        guard let state = components.queryItems?.first(where: { $0.name == "state" })?.value else {
            chatgptOAuthError = "The URL is missing the state parameter. Make sure you copied the full URL."
            return
        }

        chatgptOAuthState = .exchanging
        let success = await client.exchangeChatgptAuthCode(code: code, state: state)
        guard success else {
            chatgptOAuthState = .failed
            chatgptOAuthError = "Failed to complete sign-in. Please try again."
            return
        }

        chatgptOAuthState = .completed

        // Fetch the newly-created connection and dismiss the editor.
        if let conns = await client.listProviderConnections(provider: "openai") {
            let chatgptConn = conns.first { $0.name == "chatgpt-subscription" || $0.name == "openai-chatgpt" }
            if let conn = chatgptConn {
                connections.append(conn)
            }
        }
        await refresh()
        editorState = nil
    }

    // MARK: - Editor Validation

    /// True when the user hasn't picked a provider yet. Provider is required
    /// for a new connection — the dropdown starts empty in `beginCreate` so
    /// the user has to make an explicit choice rather than silently
    /// inheriting the first catalog entry (Anthropic), which previously led
    /// to OpenRouter / Fireworks keys being saved against the wrong provider
    /// when users pasted-and-saved without scanning the dropdown. Mirrors
    /// `InferenceProfileEditor.isProviderMissing` (PR #30313).
    private var isProviderMissing: Bool {
        editorDraft.provider.isEmpty
    }

    /// Combined gate for the primary footer button. Today provider is the
    /// only piece we lift out of `commitEditor` so the user gets immediate
    /// feedback (greyed-out Save + warning badge) instead of an error after
    /// a click; name/credential validation still runs server-side in
    /// `commitEditor` because those errors need context the dropdown can't
    /// convey (e.g. duplicate-name conflicts only the daemon knows about).
    private var canSave: Bool {
        !isProviderMissing
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
        // Provider intentionally left empty — the old pre-fill to
        // `providerCatalog.first?.id` quietly defaulted to Anthropic and led
        // users (e.g. Marina QA on 0.8.1) to paste an OpenRouter key and
        // hit Save without noticing the dropdown was still on Anthropic,
        // persisting the row as `provider=anthropic` with the OpenRouter key
        // in the credential slot. Forcing an explicit selection eliminates
        // that whole class of mismatched-provider bug. Mirrors the
        // `isProviderMissing` guard in InferenceProfileEditor (PR #30313).
        editorDraft = ConnectionDraft()
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
            baseUrl: conn.baseUrl ?? "",
            connectionModels: conn.models?.map(\.id).joined(separator: ", ") ?? ""
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
    /// rows isn't surprising; Display Name remains editable to match what the
    /// daemon allows on managed PATCHes.
    private func beginManagedEdit(_ conn: ProviderConnection) {
        actionError = nil
        isKeyDirty = true
        editorDraft = ConnectionDraft(
            name: conn.name,
            label: conn.label ?? "",
            provider: conn.provider,
            authType: conn.auth.type,
            credential: conn.auth.credential ?? "",
            baseUrl: conn.baseUrl ?? "",
            connectionModels: conn.models?.map(\.id).joined(separator: ", ") ?? ""
        )
        editorState = .managedEdit(name: conn.name)

        if conn.auth.type == "api_key", let credential = conn.auth.credential, !credential.isEmpty {
            Task {
                await loadMaskedValue(for: credential)
                await loadAvailableCredentials()
            }
        }
    }

    /// Fork the currently-loaded managed connection into a fresh `create`
    /// session. The user keeps the provider + label as a starting point
    /// (so they don't have to re-enter the easy bits) but gets a blank
    /// Key field for a unique name, fresh credential inputs, and an
    /// unlocked Auth Type defaulted to `api_key` — the whole reason to
    /// clone a managed row is to use your own credentials.
    ///
    /// Flipping `editorState` from `.managedEdit` to `.create` unlocks
    /// every behavior gate keyed off the state: `isAuthLocked` falls
    /// false (Auth Type, API Key, Advanced section all become editable),
    /// the Key field unlocks, and `commitEditor` routes through
    /// `createProviderConnection` (POST) instead of `updateProviderConnection`
    /// (PATCH) — so the daemon assigns a fresh user-owned row rather than
    /// rewriting the managed source. `ManageProvidersModal`'s equivalent
    /// in web PR #6525 makes the same one-line transition.
    private func saveAsNewFromManagedEdit() {
        actionError = nil
        // Auto-pick a unique key for the new connection. Default to
        // `${provider}-personal` (the convention the daemon uses for
        // user-owned forks of managed rows), incrementing
        // `${provider}-personal-2`, `${provider}-personal-3`, … on
        // collision. Saves the user the keystrokes of picking a name —
        // they can still edit Key before Create. Set `isKeyDirty` so the
        // label-driven auto-derive doesn't clobber this pick when the
        // user tweaks Display Name afterwards.
        let provider = editorDraft.provider
        editorDraft.name = ProvidersSheet.saveAsNewName(
            provider: provider,
            existingNames: Set(connections.map { $0.name })
        )
        isKeyDirty = true
        if provider == "ollama" {
            editorDraft.authType = "none"
            editorDraft.credential = ""
        } else {
            editorDraft.authType = "api_key"
            editorDraft.credential = "credential/\(provider)/api_key"
        }
        editorDraft.apiKeyValue = ""
        editorDraft.baseUrl = ""
        editorDraft.connectionModels = ""
        // Reset masked credential — there's no key for the new connection
        // yet, so the API Key field shows its placeholder instead of the
        // managed source's masked value. Cancel any in-flight masked-
        // value lookup first; otherwise it can resolve *after* this
        // reset and silently repopulate `maskedCredentialValue`, which
        // would let `commitEditor()` mistake the new draft for one with
        // an existing credential. Codex P2 + Devin finding on #30350.
        loadMaskedTask?.cancel()
        loadMaskedTask = nil
        maskedCredentialValue = nil
        isLoadingCredential = false
        // Pre-load available credentials so the Advanced section's
        // dropdown is populated when the user expands it. Mirrors
        // `beginCreate`.
        Task { await loadAvailableCredentials() }
        // Flip the state last so SwiftUI's diffing sees the unlocked
        // editor against the seeded draft, not the transient managed
        // values.
        editorState = .create
    }

    /// Generates a unique connection name for "Save as New" off a managed
    /// row. Starts at `${provider}-personal` and increments
    /// `${provider}-personal-2`, `${provider}-personal-3`, … until one is
    /// not in `existingNames`. Pure helper so the test suite can drive it
    /// without standing up a full sheet. Mirrors the daemon's seed naming
    /// convention for user-owned forks of canonical managed connections.
    static func saveAsNewName(provider: String, existingNames: Set<String>) -> String {
        let base = "\(provider)-personal"
        if !existingNames.contains(base) { return base }
        var index = 2
        while existingNames.contains("\(base)-\(index)") {
            index += 1
        }
        return "\(base)-\(index)"
    }


    private func commitEditor() async {
        actionError = nil
        let draft = editorDraft
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionError = "Name is required."
            return
        }
        // Belt-and-suspenders for the Save button's `isDisabled: !canSave`
        // gate: if a future caller exposes a path that bypasses the disabled
        // button (programmatic Enter-key submit, future keyboard shortcuts,
        // accidentally re-enabled state), surface the same error inline
        // instead of POSTing a row with `provider=""` to the daemon. The
        // daemon's zod schema would reject it, but the user-facing message
        // belongs here.
        guard !draft.provider.isEmpty else {
            actionError = "Select a provider."
            return
        }

        // OAuth subscription connections are created by the OAuth sign-in
        // flow (handleChatgptUrlSubmit), not the Create/Save button. Block
        // commitEditor in create mode so a user who selects "ChatGPT
        // Subscription" and clicks Create without completing the OAuth flow
        // doesn't end up with a broken connection missing OAuth tokens.
        // In edit mode the OAuth tokens are already set up, so allow saves.
        if draft.authType == "oauth_subscription" && editorState == .create {
            actionError = "Use the \"Sign in with ChatGPT\" button to connect your subscription."
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
            credential: (draft.authType == "api_key" || draft.authType == "oauth_subscription") ? credentialRef : nil
        )
        let label: String? = draft.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : draft.label.trimmingCharacters(in: .whitespacesAndNewlines)

        let baseUrlValue: String? = draft.isOpenAICompatible && !draft.baseUrl.trimmingCharacters(in: .whitespaces).isEmpty
            ? draft.baseUrl.trimmingCharacters(in: .whitespaces)
            : nil
        let modelsValue: [ConnectionModel]? = {
            guard draft.isOpenAICompatible,
                  !draft.connectionModels.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            let parsed = draft.connectionModels
                .split(separator: ",")
                .map { ConnectionModel(id: String($0).trimmingCharacters(in: .whitespaces)) }
                .filter { !$0.id.isEmpty }
            return parsed.isEmpty ? nil : parsed
        }()

        switch editorState {
        case .create:
            let result = await client.createProviderConnection(
                name: name,
                provider: draft.provider,
                auth: auth,
                label: label,
                baseUrl: baseUrlValue,
                models: modelsValue
            )
            switch result {
            case .created(let created):
                connections.append(created)
                editorState = nil
            case .duplicate:
                // 409 — surface the actual reason instead of the generic
                // fallback so users immediately see that the key (the
                // editor's "Key" field, which becomes the connection's
                // unique name) collides with an existing connection.
                actionError = "A connection named \"\(name)\" already exists."
                return
            case .invalid(let message):
                // 400 — daemon often includes a useful structured reason
                // (e.g. `Invalid provider "x". Valid: ...`). Surface it
                // verbatim when present; fall back to a generic invalid
                // message otherwise.
                actionError = message ?? "Invalid configuration. Check the provider and auth settings."
                return
            case .error:
                actionError = "Couldn't create connection. Please try again."
                return
            }

        case .edit(let originalName), .managedEdit(let originalName):
            // Managed-edit and user-edit share the same PATCH path. The auth
            // fields are locked in the UI for managed connections, so the
            // draft's authType/credential haven't changed; if a user
            // somehow bypassed that, the daemon enforces the same
            // write-protection and returns a 400 we surface as actionError.
            guard let updated = await client.updateProviderConnection(
                name: originalName,
                auth: auth,
                label: .some(label),
                baseUrl: draft.isOpenAICompatible ? .some(baseUrlValue) : .none,
                models: draft.isOpenAICompatible ? .some(modelsValue) : .none
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
