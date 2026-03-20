import SwiftUI
import VellumAssistantShared

struct MessageInspectorPayloadView: View {
    let title: String
    @Binding var model: MessageInspectorPayloadModel
    let viewportHeight: CGFloat

    @State private var isActivelyEditing = false
    @State private var expandAllTrigger = 0
    @State private var collapseAllTrigger = 0
    @State private var isTreeExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            header
            content
        }
        .onChange(of: model.viewMode) { _, newMode in
            if newMode != .tree {
                isTreeExpanded = false
            }
        }
        .onChange(of: model.source) { _, _ in
            isTreeExpanded = false
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text(title)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentDefault)

            Spacer(minLength: VSpacing.md)

            if model.showsViewModePicker {
                VSegmentedControl(
                    items: model.availableViewModes.map { (label: $0.label, tag: $0) },
                    selection: viewModeBinding,
                    style: .pill,
                    size: .compact
                )
                .fixedSize()
            }

            if model.showsExpandCollapseActions {
                VButton(
                    label: isTreeExpanded ? "Collapse All" : "Expand All",
                    iconOnly: (isTreeExpanded ? VIcon.minimize : VIcon.maximize).rawValue,
                    style: .ghost,
                    size: .compact,
                    tooltip: isTreeExpanded ? "Collapse All" : "Expand All"
                ) {
                    if isTreeExpanded {
                        collapseAllTrigger += 1
                    } else {
                        expandAllTrigger += 1
                    }
                    isTreeExpanded.toggle()
                }
            }

            VCopyButton(
                text: model.source,
                size: .compact,
                accessibilityHint: "Copy \(title)"
            )
        }
    }

    private var content: some View {
        Group {
            switch model.viewMode {
            case .tree:
                JSONTreeView(
                    content: model.source,
                    expandAllTrigger: expandAllTrigger,
                    collapseAllTrigger: collapseAllTrigger
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            case .source:
                HighlightedTextView(
                    text: .constant(model.source),
                    language: model.isTreeAvailable ? .json : .plain,
                    isEditable: false,
                    isActivelyEditing: $isActivelyEditing
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: viewportHeight)
        .background(VColor.surfaceBase)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    private var viewModeBinding: Binding<MessageInspectorPayloadViewMode> {
        Binding(
            get: { model.viewMode },
            set: { model.viewMode = $0 }
        )
    }
}
