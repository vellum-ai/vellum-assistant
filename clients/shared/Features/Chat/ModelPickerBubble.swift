import SwiftUI

public struct ModelPickerBubble: View {
    let models: [(id: String, name: String)]
    let selectedModelId: String
    let onSelect: (String) -> Void

    @State private var hoveredModelId: String?

    public init(models: [(id: String, name: String)], selectedModelId: String, onSelect: @escaping (String) -> Void) {
        self.models = models
        self.selectedModelId = selectedModelId
        self.onSelect = onSelect
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(models, id: \.id) { model in
                modelRow(model)
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .frame(maxWidth: 280)
    }

    private func modelRow(_ model: (id: String, name: String)) -> some View {
        let isSelected = model.id == selectedModelId
        let isHovered = hoveredModelId == model.id
        return Button {
            onSelect(model.id)
        } label: {
            HStack(spacing: VSpacing.md) {
                VIconView(isSelected ? .circleCheck : .circle, size: 12)
                    .foregroundColor(isSelected ? VColor.accent : (isHovered ? VColor.textPrimary : VColor.textSecondary))
                    .frame(width: 18)
                Text(model.name)
                    .font(isSelected ? VFont.bodyBold : VFont.body)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.sm)
            .background(isHovered ? VColor.hoverOverlay.opacity(0.06) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredModelId = hovering ? model.id : nil
        }
        .pointerCursor()
    }
}
