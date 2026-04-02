import SwiftUI
import VellumAssistantShared

// MARK: - View Mode

extension MemoryItemDetailSheet {

    @ViewBuilder
    var viewModeContent: some View {
        // Skill/procedural banner
        if displayItem.kind == MemoryKind.procedural.rawValue {
            HStack(spacing: VSpacing.sm) {
                VIconView(.zap, size: 14)
                    .foregroundStyle(VColor.funRed)
                Text("Capability — not a personal memory")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.funRed)
            }
            .padding(VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.funRed.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }

        // Statement — no label, the VModal title already shows the subject
        Text(displayItem.statement)
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentDefault)
            .textSelection(.enabled)

        // Classification group
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Classification")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentTertiary)
            HStack(spacing: VSpacing.sm) {
                kindBadge
                Text("·").foregroundStyle(VColor.contentTertiary)
                Text(displayItem.status.capitalized)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            if let sourceType = displayItem.sourceType {
                sourceTypeIndicator(sourceType)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceActive.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

        // Strength group
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Strength")
                .font(VFont.bodySmallEmphasised)
                .foregroundStyle(VColor.contentTertiary)
            if let confidence = displayItem.confidence {
                HStack(spacing: VSpacing.xs) {
                    Text("Confidence")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 90, alignment: .leading)
                    metricBar(value: confidence,
                              color: confidenceColor(confidence))
                    Text("\(Int(confidence * 100))%")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            if let importance = displayItem.importance {
                HStack(spacing: VSpacing.xs) {
                    Text("Importance")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 90, alignment: .leading)
                    metricBar(value: importance, color: VColor.primaryBase)
                    Text("\(Int(importance * 100))%")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            if let count = displayItem.reinforcementCount, count > 0 {
                metadataRow(label: "Reinforced", value: "\(count) time\(count == 1 ? "" : "s")")
            }
        }
        .padding(VSpacing.md)
        .background(VColor.surfaceActive.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

        // Timeline group (collapsed by default)
        VDisclosureSection(
            title: "Timeline",
            icon: VIcon.clock.rawValue,
            isExpanded: $isTimelineExpanded
        ) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                metadataRow(label: "First seen", value: formattedDate(displayItem.firstSeenDate))
                metadataRow(label: "Last seen", value: formattedDate(displayItem.lastSeenDate))
                if let lastUsedDate = displayItem.lastUsedDate {
                    metadataRow(label: "Last used", value: formattedDate(lastUsedDate))
                }
                if let fidelity = displayItem.fidelity {
                    metadataRow(label: "Fidelity", value: fidelity.capitalized)
                }
                if let scopeLabel = displayItem.scopeLabel {
                    metadataRow(label: "Scope", value: scopeLabel)
                }
            }
        }

        // Possibly Related section
        let related = relatedItems
        if !related.isEmpty {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Possibly Related")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentTertiary)
                ForEach(related) { relatedItem in
                    Button {
                        onNavigate?(relatedItem)
                    } label: {
                        HStack(spacing: VSpacing.sm) {
                            Circle()
                                .fill(MemoryKind(rawValue: relatedItem.kind)?.color ?? VColor.contentTertiary)
                                .frame(width: 6, height: 6)
                            Text(relatedItem.subject)
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                                .lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var relatedItems: [MemoryItemPayload] {
        let stopWords: Set<String> = ["the", "and", "that", "this", "with", "from", "have", "been", "was", "were", "are", "for", "not"]
        let words = Set(
            displayItem.subject
                .lowercased()
                .split(separator: " ")
                .map(String.init)
                .filter { $0.count > 3 && !stopWords.contains($0) }
        )
        guard !words.isEmpty else { return [] }

        return store.items
            .filter { $0.id != displayItem.id && $0.kind == displayItem.kind }
            .filter { candidate in
                let candidateWords = Set(
                    candidate.subject.lowercased()
                        .split(separator: " ")
                        .map(String.init)
                        .filter { $0.count > 3 && !stopWords.contains($0) }
                )
                return !words.isDisjoint(with: candidateWords)
            }
            .prefix(3)
            .map { $0 }
    }
}

// MARK: - Edit Mode

extension MemoryItemDetailSheet {

    @ViewBuilder
    var editModeContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Subject")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                VTextField(placeholder: "Brief topic or label", text: $editSubject)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Statement")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                TextEditor(text: $editStatement)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDefault)
                    .scrollContentBackground(.hidden)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceActive)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .frame(minHeight: 100)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Kind")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                VDropdown(
                    placeholder: "Kind",
                    selection: $editKind,
                    options: MemoryKind.editableKinds(current: editBaseline?.kind ?? displayItem.kind).map { ($0.label, $0.rawValue) }
                )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Status")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                VDropdown(
                    placeholder: "Status",
                    selection: $editStatus,
                    options: [("Active", "active"), ("Inactive", "inactive")]
                )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                HStack {
                    Text("Importance")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                    Spacer()
                    Text("\(Int(editImportance * 100))%")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
                VSlider(value: $editImportance, range: 0...1, step: 0.1)
            }
        }
    }
}
