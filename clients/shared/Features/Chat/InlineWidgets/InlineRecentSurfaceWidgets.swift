#if os(macOS)
import AppKit
import SwiftUI

private enum InlineOAuthProviderLogoBundle {
    private static var nsImageStore: [String: NSImage] = [:]
    private static var missStore: Set<String> = []
    private static let nsImageLock = NSLock()

    static func bundledImage(providerKey: String) -> NSImage? {
        let key = normalizedProviderKey(providerKey)

        nsImageLock.lock()
        if let cached = nsImageStore[key] {
            nsImageLock.unlock()
            return cached
        }
        if missStore.contains(key) {
            nsImageLock.unlock()
            return nil
        }
        nsImageLock.unlock()

        guard
            let url = Bundle.vellumShared.url(
                forResource: key,
                withExtension: "pdf",
                subdirectory: "IntegrationLogos"
            ),
            let image = NSImage(contentsOf: url)
        else {
            nsImageLock.lock()
            missStore.insert(key)
            nsImageLock.unlock()
            return nil
        }

        nsImageLock.lock()
        if let existing = nsImageStore[key] {
            nsImageLock.unlock()
            return existing
        }
        nsImageStore[key] = image
        nsImageLock.unlock()
        return image
    }

    private static func normalizedProviderKey(_ providerKey: String) -> String {
        providerKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

public struct InlineChoiceWidget: View {
    public let data: ChoiceSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []
    @State private var submittingActionId: String?

    public init(data: ChoiceSurfaceData, onAction: @escaping (String, [String: AnyCodable]?) -> Void) {
        self.data = data
        self.onAction = onAction
    }

    private var commitOnSelect: Bool {
        data.selectionMode == .single ? data.commitOnSelect != false : false
    }

    private var selectedOptions: [ChoiceOptionData] {
        data.options.filter { selectedIds.contains($0.id) }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            if let description = data.description, !description.isEmpty {
                Text(markdown(description))
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .textSelection(.enabled)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                ForEach(data.options) { option in
                    optionRow(option)
                }
            }

            if !commitOnSelect {
                HStack {
                    Spacer()
                    VButton(
                        label: data.submitLabel ?? "Continue",
                        style: .primary,
                        isDisabled: selectedOptions.isEmpty || submittingActionId != nil
                    ) {
                        submitSelectedOptions()
                    }
                }
            }
        }
        .onAppear {
            guard selectedIds.isEmpty, data.selectionMode == .multiple else { return }
            selectedIds = Set(data.options.filter(\.recommended).map(\.id))
        }
    }

    private func optionRow(_ option: ChoiceOptionData) -> some View {
        let isSelected = selectedIds.contains(option.id)
        let isSubmitting = submittingActionId == option.id
        return Button {
            toggleOption(option)
        } label: {
            HStack(alignment: .top, spacing: VSpacing.sm) {
                ZStack {
                    Circle()
                        .stroke(isSelected || option.recommended ? VColor.primaryBase : VColor.borderBase, lineWidth: 1)
                        .background(
                            Circle()
                                .fill(isSelected ? VColor.primaryBase : VColor.surfaceBase)
                        )
                    if isSubmitting {
                        VLoadingIndicator(size: 12, color: isSelected ? VColor.auxWhite : VColor.primaryBase)
                    } else if isSelected {
                        VIconView(.check, size: 11)
                            .foregroundStyle(VColor.auxWhite)
                    }
                }
                .frame(width: 18, height: 18)
                .padding(.top, 2)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    HStack(spacing: VSpacing.sm) {
                        Text(option.title)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                            .multilineTextAlignment(.leading)

                        if option.recommended {
                            Text("Recommended")
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.primaryBase)
                                .padding(.horizontal, VSpacing.sm)
                                .padding(.vertical, 2)
                                .background(
                                    Capsule()
                                        .fill(VColor.primaryBase.opacity(0.12))
                                )
                        }
                    }

                    if let description = option.description, !description.isEmpty {
                        Text(description)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .multilineTextAlignment(.leading)
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected || option.recommended ? VColor.primaryBase.opacity(0.08) : VColor.surfaceBase)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected || option.recommended ? VColor.primaryBase : VColor.borderBase, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(submittingActionId != nil)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private func toggleOption(_ option: ChoiceOptionData) {
        if commitOnSelect {
            submitOption(option)
            return
        }

        if data.selectionMode == .single {
            selectedIds = selectedIds.contains(option.id) ? [] : [option.id]
        } else {
            if selectedIds.contains(option.id) {
                selectedIds.remove(option.id)
            } else {
                selectedIds.insert(option.id)
            }
        }
    }

    private func submitOption(_ option: ChoiceOptionData) {
        guard submittingActionId == nil else { return }
        submittingActionId = option.id
        onAction(option.id, payload(for: option))
    }

    private func submitSelectedOptions() {
        guard !selectedOptions.isEmpty, submittingActionId == nil else { return }
        submittingActionId = "submit"
        onAction("submit", selectedOptionsPayload())
    }

    private func payload(for option: ChoiceOptionData) -> [String: AnyCodable] {
        var payload: [String: AnyCodable] = [
            "choiceId": AnyCodable(option.id),
            "choiceTitle": AnyCodable(option.title),
            "selectedIds": AnyCodable([option.id as Any?]),
            "selectedTitles": AnyCodable([option.title as Any?])
        ]
        if let description = option.description {
            payload["choiceDescription"] = AnyCodable(description)
        }
        if option.recommended {
            payload["recommended"] = AnyCodable(true)
        }
        if let data = option.data {
            for (key, value) in data {
                payload[key] = value
            }
        }
        return payload
    }

    private func selectedOptionsPayload() -> [String: AnyCodable] {
        let choices: [Any?] = selectedOptions.map { option in
            var dict: [String: Any?] = [
                "id": option.id,
                "title": option.title
            ]
            if let description = option.description {
                dict["description"] = description
            }
            if option.recommended {
                dict["recommended"] = true
            }
            if let data = option.data {
                dict["data"] = data.mapValues { $0.value }
            }
            return dict
        }

        return [
            "selectedIds": AnyCodable(selectedOptions.map { $0.id as Any? }),
            "selectedTitles": AnyCodable(selectedOptions.map { $0.title as Any? }),
            "choices": AnyCodable(choices)
        ]
    }

    private func markdown(_ value: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: value, options: options)) ?? AttributedString(value)
    }
}

public struct InlineTaskPreferencesWidget: View {
    public let title: String?
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedTasks: Set<String> = []
    @State private var otherSelected = false
    @State private var otherText = ""
    @State private var isSubmitting = false

    public init(title: String?, onAction: @escaping (String, [String: AnyCodable]?) -> Void) {
        self.title = title
        self.onAction = onAction
    }

    private struct TaskCategory: Identifiable {
        let id: String
        let icon: VIcon
        let label: String
        let sublabel: String
    }

    private let taskCategories: [TaskCategory] = [
        TaskCategory(id: "code-building", icon: .wrench, label: "Building", sublabel: "code, apps, tools"),
        TaskCategory(id: "writing", icon: .pencil, label: "Writing", sublabel: "docs, emails, content"),
        TaskCategory(id: "research", icon: .search, label: "Researching", sublabel: "digging into stuff, analysis"),
        TaskCategory(id: "project-management", icon: .clipboardList, label: "Planning & coordinating", sublabel: "roadmaps, specs, tracking work"),
        TaskCategory(id: "scheduling", icon: .calendar, label: "Scheduling", sublabel: "meetings, calendar, logistics"),
        TaskCategory(id: "personal", icon: .user, label: "Life admin", sublabel: "bills, travel, household, errands"),
    ]

    private var trimmedOtherText: String {
        otherText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool {
        !selectedTasks.isEmpty || (otherSelected && !trimmedOtherText.isEmpty)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(title ?? "What can I help with?")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text("Select all that apply")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            LazyVGrid(columns: [GridItem(.flexible(), spacing: VSpacing.sm), GridItem(.flexible(), spacing: VSpacing.sm)], alignment: .leading, spacing: VSpacing.sm) {
                ForEach(taskCategories) { category in
                    taskTile(category)
                }
            }

            otherTile

            VButton(
                label: "Continue",
                style: .primary,
                isFullWidth: true,
                isDisabled: !canSubmit || isSubmitting
            ) {
                submit()
            }
        }
    }

    private func taskTile(_ category: TaskCategory) -> some View {
        let isSelected = selectedTasks.contains(category.id)
        return Button {
            toggleTask(category.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack {
                    VIconView(category.icon, size: 16)
                        .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                    Spacer(minLength: 0)
                    if isSelected {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.contentInset)
                            .frame(width: 18, height: 18)
                            .background(RoundedRectangle(cornerRadius: VRadius.sm).fill(VColor.primaryBase))
                    }
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(category.label)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(2)
                    Text(category.sublabel)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 88, alignment: .topLeading)
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : VColor.surfaceBase)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(isSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }

    private var otherTile: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Button {
                otherSelected.toggle()
                if !otherSelected {
                    otherText = ""
                }
            } label: {
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    VIconView(.messageSquare, size: 16)
                        .foregroundStyle(otherSelected ? VColor.primaryBase : VColor.contentSecondary)
                        .frame(width: 22, height: 22)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Other")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentDefault)
                        Text("something else entirely")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }

                    Spacer(minLength: 0)

                    if otherSelected {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.contentInset)
                            .frame(width: 18, height: 18)
                            .background(RoundedRectangle(cornerRadius: VRadius.sm).fill(VColor.primaryBase))
                    }
                }
                .padding(VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(otherSelected ? VColor.primaryBase.opacity(0.08) : VColor.surfaceBase)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(otherSelected ? VColor.primaryBase : VColor.borderBase, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .disabled(isSubmitting)

            if otherSelected {
                TextField("Describe what you need help with...", text: $otherText, axis: .vertical)
                    .font(VFont.bodyMediumDefault)
                    .textFieldStyle(.plain)
                    .lineLimit(1...4)
                    .padding(VSpacing.md)
                    .background(RoundedRectangle(cornerRadius: VRadius.md).fill(VColor.surfaceBase))
                    .overlay(RoundedRectangle(cornerRadius: VRadius.md).stroke(VColor.borderBase, lineWidth: 1))
            }
        }
    }

    private func toggleTask(_ id: String) {
        if selectedTasks.contains(id) {
            selectedTasks.remove(id)
        } else {
            selectedTasks.insert(id)
        }
    }

    private func submit() {
        guard canSubmit, !isSubmitting else { return }
        isSubmitting = true
        var payload: [String: AnyCodable] = [
            "tasks": AnyCodable(taskCategories.filter { selectedTasks.contains($0.id) }.map { $0.id as Any? })
        ]
        if !trimmedOtherText.isEmpty {
            payload["customText"] = AnyCodable(trimmedOtherText)
        }
        onAction("submit", payload)
    }
}

public struct InlineCopyBlockWidget: View {
    public let data: CopyBlockSurfaceData

    public init(data: CopyBlockSurfaceData) {
        self.data = data
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let label = data.label ?? data.language, !label.isEmpty {
                Text(label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
            }

            ScrollView {
                Text(data.text)
                    .font(Font(VFont.nsMono))
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 320)

            HStack {
                Spacer()
                VCopyButton(text: data.text, size: .compact)
            }
        }
    }
}

public struct InlineOAuthConnectWidget: View {
    public let data: OAuthConnectSurfaceData
    public let title: String?
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var state: ConnectState = .idle
    @State private var errorMessage: String?

    public init(
        data: OAuthConnectSurfaceData,
        title: String?,
        onAction: @escaping (String, [String: AnyCodable]?) -> Void
    ) {
        self.data = data
        self.title = title
        self.onAction = onAction
    }

    private enum ConnectState {
        case idle
        case connecting
        case connected
    }

    private var providerLabel: String {
        if let displayName = data.displayName, !displayName.isEmpty {
            return displayName
        }
        return data.providerKey
            .split { $0 == "-" || $0 == "_" }
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    private var description: String {
        data.description ?? "Connect \(providerLabel) so I can use it for this task."
    }

    private var logoURL: URL? {
        guard let logoUrl = data.logoUrl?.trimmingCharacters(in: .whitespacesAndNewlines),
              !logoUrl.isEmpty else { return nil }
        return URL(string: logoUrl)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                providerAvatar

                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(title ?? "Connect \(providerLabel)")
                        .font(VFont.bodySmallEmphasised)
                        .foregroundStyle(VColor.contentDefault)

                    Text(description)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)

                    if let errorMessage {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleX, size: 12)
                            Text(errorMessage)
                                .font(VFont.labelDefault)
                        }
                        .foregroundStyle(VColor.systemNegativeStrong)
                    } else if state == .connected {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 12)
                            Text("Connected")
                                .font(VFont.labelDefault)
                        }
                        .foregroundStyle(VColor.systemPositiveStrong)
                    }
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: VSpacing.sm) {
                Spacer()
                VButton(
                    label: "Dismiss",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    isDisabled: state == .connecting
                ) {
                    submitCancel()
                }
                VButton(
                    label: state == .connecting ? "Waiting..." : "Connect",
                    icon: state == .connecting ? nil : VIcon.externalLink.rawValue,
                    style: .primary,
                    isDisabled: state == .connecting || state == .connected
                ) {
                    connect()
                }
            }
        }
    }

    private var providerAvatar: some View {
        ZStack {
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)

            if let image = InlineOAuthProviderLogoBundle.bundledImage(providerKey: data.providerKey) {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 28, height: 28)
            } else if let logoURL {
                VCachedRemoteImage(
                    url: logoURL,
                    content: { image in
                        image
                            .resizable()
                            .interpolation(.high)
                            .aspectRatio(contentMode: .fit)
                    },
                    placeholder: {
                        providerInitialsAvatar
                    }
                )
                .frame(width: 28, height: 28)
            } else {
                providerInitialsAvatar
            }
        }
        .frame(width: 40, height: 40)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    private var providerInitialsAvatar: some View {
        let initials = String(providerLabel.prefix(2)).uppercased()
        return ZStack {
            Circle()
                .fill(providerColor)
            Text(initials)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(VColor.auxWhite)
        }
        .frame(width: 28, height: 28)
    }

    private var providerColor: Color {
        let palette: [Color] = [
            VColor.primaryBase,
            VColor.systemPositiveStrong,
            VColor.systemMidStrong,
            VColor.systemNegativeStrong,
            VColor.contentSecondary
        ]
        let index = Int(data.providerKey.utf8.reduce(0 as UInt32) { $0 &+ UInt32($1) }) % palette.count
        return palette[index]
    }

    private func submitCancel() {
        onAction("cancel", [
            "status": AnyCodable("cancelled"),
            "providerKey": AnyCodable(data.providerKey),
            "providerLabel": AnyCodable(providerLabel)
        ])
    }

    private func connect() {
        guard state != .connecting else { return }
        state = .connecting
        errorMessage = nil
        Task {
            let result = await OAuthConnectSurfaceCoordinator.shared.connect(
                providerKey: data.providerKey,
                providerLabel: providerLabel
            )
            switch result {
            case .connected(let connection):
                state = .connected
                onAction("connect", connectedPayload(connection: connection))
            case .cancelled:
                state = .idle
                submitCancel()
            case .error(let message):
                state = .idle
                errorMessage = message
            }
        }
    }

    private func connectedPayload(connection: OAuthConnectionEntry?) -> [String: AnyCodable] {
        var payload: [String: AnyCodable] = [
            "status": AnyCodable("connected"),
            "providerKey": AnyCodable(data.providerKey),
            "providerLabel": AnyCodable(providerLabel),
            "scopesGranted": AnyCodable((connection?.scopes_granted ?? []).map { $0 as Any? })
        ]
        if let id = connection?.id {
            payload["connectionId"] = AnyCodable(id)
        }
        if let accountLabel = connection?.account_label {
            payload["accountLabel"] = AnyCodable(accountLabel)
        }
        return payload
    }
}

public struct InlineWorkResultWidget: View {
    public let title: String
    public let data: WorkResultSurfaceData

    public init(title: String, data: WorkResultSurfaceData) {
        self.title = title
        self.data = data
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack(alignment: .top, spacing: VSpacing.md) {
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        if let eyebrow = data.eyebrow {
                            Text(eyebrow.uppercased())
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                        }
                        Text(title)
                            .font(VFont.titleSmall)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    Spacer(minLength: 0)
                    if let status = data.status {
                        statusBadge(status)
                    }
                }

                if let summary = data.summary {
                    Text(summary)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                }
            }

            metricGrid

            if !data.sections.isEmpty {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    ForEach(data.sections) { section in
                        sectionView(section)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var metricGrid: some View {
        if !data.metrics.isEmpty {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: VSpacing.sm)], alignment: .leading, spacing: VSpacing.sm) {
                ForEach(Array(data.metrics.enumerated()), id: \.offset) { _, metric in
                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(metric.value)
                            .font(VFont.titleSmall)
                            .foregroundStyle(toneForeground(metric.tone))
                            .lineLimit(1)
                        Text(metric.label)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .lineLimit(1)
                        if let detail = metric.detail {
                            Text(detail)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentTertiary)
                                .lineLimit(1)
                        }
                    }
                    .padding(VSpacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceBase)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                }
            }
        }
    }

    private func sectionView(_ section: WorkResultSection) -> some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            sectionIcon(section.type)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(section.title)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)

                if let description = section.description {
                    Text(description)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }

                if section.type == .diff {
                    diffList(section.diffs)
                } else {
                    itemList(section.items, sectionType: section.type)
                }
            }
        }
        .padding(.top, VSpacing.md)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(VColor.borderBase)
                .frame(height: 1)
        }
    }

    private func itemList(_ items: [WorkResultItem], sectionType: WorkResultSectionType) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(items) { item in
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    VIconView(itemIcon(item, sectionType: sectionType), size: 16)
                        .foregroundStyle(toneForeground(item.tone))
                        .frame(width: 22, height: 22)

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        HStack(spacing: VSpacing.sm) {
                            if let href = item.href, let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                                Link(item.title, destination: url)
                                    .font(VFont.bodyMediumDefault)
                            } else {
                                Text(item.title)
                                    .font(VFont.bodyMediumDefault)
                                    .foregroundStyle(VColor.contentDefault)
                            }

                            if let status = item.status {
                                Text(status)
                                    .font(VFont.labelDefault)
                                    .foregroundStyle(VColor.contentSecondary)
                                    .padding(.horizontal, VSpacing.sm)
                                    .padding(.vertical, 2)
                                    .background(Capsule().fill(VColor.surfaceActive))
                            }
                        }

                        if let description = item.description {
                            Text(description)
                                .font(VFont.labelDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }

                        if !item.metadata.isEmpty {
                            metadataRow(item.metadata)
                        }
                    }
                }
                .padding(.vertical, VSpacing.sm)
            }
        }
    }

    private func diffList(_ diffs: [WorkResultDiff]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(diffs) { diff in
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    if let label = diff.label {
                        Text(label)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                    }

                    HStack(alignment: .top, spacing: VSpacing.sm) {
                        diffColumn(label: "Before", value: diff.before ?? "Not set", emphasized: false)
                        VIconView(.arrowRight, size: 14)
                            .foregroundStyle(VColor.contentTertiary)
                            .padding(.top, VSpacing.lg)
                        diffColumn(label: "After", value: diff.after ?? "Removed", emphasized: true)
                    }
                }
            }
        }
    }

    private func diffColumn(label: String, value: String, emphasized: Bool) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
            Text(value)
                .font(VFont.labelDefault)
                .foregroundStyle(emphasized ? VColor.contentDefault : VColor.contentSecondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(VSpacing.sm)
        .background(RoundedRectangle(cornerRadius: VRadius.sm).fill(VColor.surfaceBase))
        .overlay(RoundedRectangle(cornerRadius: VRadius.sm).stroke(VColor.borderBase, lineWidth: 1))
    }

    private func metadataRow(_ metadata: [WorkResultMetadata]) -> some View {
        HStack(spacing: VSpacing.xs) {
            ForEach(Array(metadata.enumerated()), id: \.offset) { _, metadata in
                Text("\(metadata.label): \(metadata.value)")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(VColor.surfaceActive))
            }
        }
    }

    private func statusBadge(_ status: WorkResultStatus) -> some View {
        let label: String
        let icon: VIcon
        let tone: WorkResultTone
        switch status {
        case .completed:
            label = "Completed"
            icon = .circleCheck
            tone = .positive
        case .partial:
            label = "Partial"
            icon = .triangleAlert
            tone = .warning
        case .failed:
            label = "Needs attention"
            icon = .circleX
            tone = .negative
        case .inProgress:
            label = "In progress"
            icon = .clock
            tone = .neutral
        }

        return HStack(spacing: VSpacing.xs) {
            VIconView(icon, size: 12)
            Text(label)
                .font(VFont.labelDefault)
        }
        .foregroundStyle(toneForeground(tone))
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, 4)
        .background(Capsule().fill(toneBackground(tone)))
    }

    private func sectionIcon(_ type: WorkResultSectionType) -> some View {
        let icon: VIcon = switch type {
        case .warnings: .triangleAlert
        case .artifacts: .fileText
        case .diff: .arrowRight
        case .timeline: .clock
        case .items: .sparkles
        }
        let tone: WorkResultTone = switch type {
        case .warnings: .warning
        case .artifacts: .positive
        default: .neutral
        }
        return VIconView(icon, size: 16)
            .foregroundStyle(toneForeground(tone))
            .frame(width: 28, height: 28)
            .background(RoundedRectangle(cornerRadius: VRadius.md).fill(toneBackground(tone)))
    }

    private func itemIcon(_ item: WorkResultItem, sectionType: WorkResultSectionType) -> VIcon {
        if item.tone == .positive { return .circleCheck }
        if item.tone == .warning { return .triangleAlert }
        if item.tone == .negative { return .circleX }
        if sectionType == .artifacts { return .fileText }
        if sectionType == .timeline { return .circleDot }
        return .listChecks
    }

    private func toneForeground(_ tone: WorkResultTone?) -> Color {
        switch tone {
        case .positive:
            return VColor.systemPositiveStrong
        case .warning:
            return VColor.systemMidStrong
        case .negative:
            return VColor.systemNegativeStrong
        default:
            return VColor.contentSecondary
        }
    }

    private func toneBackground(_ tone: WorkResultTone?) -> Color {
        switch tone {
        case .positive:
            return VColor.systemPositiveWeak
        case .warning:
            return VColor.systemMidWeak
        case .negative:
            return VColor.systemNegativeWeak
        default:
            return VColor.surfaceBase
        }
    }
}
#endif
