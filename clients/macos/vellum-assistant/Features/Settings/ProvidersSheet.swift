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

    // MARK: - Nested Types

    struct ConnectionDraft {
        var name = ""
        var label = ""
        var provider = ""
        var authType = "api_key"
        var credential = ""
        var status: ConnectionStatus = .active
    }

    enum EditorState {
        case create
        case edit(name: String)
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
        HStack(alignment: .center, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                if let label = conn.label {
                    Text(label)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)
                    HStack(spacing: VSpacing.xs) {
                        Text("@\(conn.name)")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentSecondary)
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
                        if conn.status == .disabled {
                            VBadge(label: "Disabled", tone: .warning, emphasis: .subtle)
                        }
                    }
                } else {
                    HStack(spacing: VSpacing.xs) {
                        Text(conn.name)
                            .font(VFont.bodyMediumEmphasised)
                            .foregroundStyle(VColor.contentDefault)
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
                        if conn.status == .disabled {
                            VBadge(label: "Disabled", tone: .warning, emphasis: .subtle)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: VSpacing.xs) {
                VButton(label: "Edit", style: .ghost) {
                    beginEdit(conn)
                }
                VButton(label: "Delete", style: .ghost) {
                    Task { await attemptDelete(conn.name) }
                }
            }
        }
        .padding(.vertical, VSpacing.xs)
        .contentShape(Rectangle())
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
                    editorAuthTypeField
                    if editorDraft.authType == "api_key" {
                        editorCredentialField
                    } else if editorDraft.authType == "platform" {
                        editorPlatformNote
                    } else if editorDraft.authType == "none" {
                        editorNoneNote
                    }
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
    }

    private var editorHeader: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            let title: String = {
                switch editorState {
                case .create: return "New Connection"
                case .edit(let name): return "Edit \"\(name)\""
                case nil: return ""
                }
            }()
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
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

    private var editorCredentialField: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Credential Reference")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
            VTextField(
                placeholder: "secret-name",
                text: $editorDraft.credential
            )
            Text("The name of the secret in your credential store.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
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
        editorDraft = ConnectionDraft(
            provider: store.providerCatalog.first?.id ?? ""
        )
        editorState = .create
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
    }

    private func commitEditor() async {
        actionError = nil
        let draft = editorDraft
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            actionError = "Name is required."
            return
        }

        let auth = ProviderConnectionAuth(
            type: draft.authType,
            credential: draft.authType == "api_key"
                ? draft.credential.trimmingCharacters(in: .whitespacesAndNewlines)
                : nil
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

        case .edit(let originalName):
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
