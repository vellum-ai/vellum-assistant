import SwiftUI
import VellumAssistantShared

// MARK: - View Mode

extension MemoryItemDetailSheet {

    @ViewBuilder
    var viewModeContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Statement")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)
            Text(displayItem.statement)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)
        }

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Details")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentTertiary)

            HStack(spacing: VSpacing.xs) {
                Text("Kind")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: 110, alignment: .leading)
                kindBadge
            }
            metadataRow(label: "Status", value: displayItem.status.capitalized)
            metadataRow(label: "Confidence", value: "\(Int(displayItem.confidence * 100))%")
            if let importance = displayItem.importance {
                metadataRow(label: "Importance", value: "\(Int(importance * 100))%")
            }

            HStack(spacing: VSpacing.xs) {
                Text("Verification")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
                    .frame(width: 110, alignment: .leading)
                if displayItem.isUserConfirmed {
                    VIconView(.circleCheck, size: 13)
                        .foregroundStyle(VColor.systemPositiveStrong)
                    Text("Confirmed by you")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                } else if displayItem.isUserReported {
                    VIconView(.user, size: 12)
                        .foregroundStyle(VColor.contentSecondary)
                    Text("Reported by you")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                } else {
                    VIconView(.sparkles, size: 13)
                        .foregroundStyle(VColor.contentTertiary)
                    Text("Inferred by assistant")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }

            if let scopeLabel = displayItem.scopeLabel {
                HStack(spacing: VSpacing.xs) {
                    Text("Scope")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 110, alignment: .leading)
                    VIconView(.lock, size: 12)
                        .foregroundStyle(VColor.contentSecondary)
                    Text(scopeLabel)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }

            metadataRow(label: "First seen", value: formattedDate(displayItem.firstSeenDate))
            metadataRow(label: "Last seen", value: formattedDate(displayItem.lastSeenDate))
            if let lastUsedDate = displayItem.lastUsedDate {
                metadataRow(label: "Last used", value: formattedDate(lastUsedDate))
            }
            metadataRow(label: "Access count", value: "\(displayItem.accessCount)")

            if let supersededBySubject = displayItem.supersededBySubject {
                metadataRow(label: "Superseded by", value: supersededBySubject)
            }
            if let supersedesSubject = displayItem.supersedesSubject {
                metadataRow(label: "Supersedes", value: supersedesSubject)
            }
        }
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
