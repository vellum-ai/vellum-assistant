import SwiftUI
import VellumAssistantShared

@MainActor
struct TaskToneSelectionView: View {
    // MARK: - Bindings

    @Binding var selectedTasks: Set<String>

    // MARK: - Callbacks

    var onBack: (() -> Void)?
    var onContinue: () -> Void
    var onSkip: () -> Void

    // MARK: - Private State

    @State private var showTitle = false
    @State private var showContent = false
    @State private var hoveredTask: String?

    // MARK: - Task Categories

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

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
        // Header
        ZStack(alignment: .leading) {
            Text("What are you working on?")
                .font(VFont.titleLarge)
                .foregroundStyle(VColor.contentDefault)
                .frame(maxWidth: .infinity)

            if let onBack {
                Button {
                    onBack()
                } label: {
                    VIconView(.chevronLeft, size: 16)
                        .foregroundStyle(VColor.contentSecondary)
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel("Back")
                .padding(.leading, VSpacing.xxl)
            }
        }
        .opacity(showTitle ? 1 : 0)
        .offset(y: showTitle ? 0 : 8)
        .padding(.bottom, VSpacing.sm)

        Text("Pick the one or two you do most — you can select more if it really is all of it.")
            .font(VFont.bodyMediumLighter)
            .foregroundStyle(VColor.contentSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, VSpacing.xxl)
            .opacity(showTitle ? 1 : 0)
            .offset(y: showTitle ? 0 : 8)
            .padding(.bottom, VSpacing.xl)

        // Content
        VStack(spacing: VSpacing.xl) {
            // Task categories
            VStack(spacing: VSpacing.xs) {
                ForEach(taskCategories) { category in
                    taskRow(category)
                }
            }

            // Footer buttons
            VStack(spacing: VSpacing.sm) {
                VButton(label: "Continue", style: .primary, isFullWidth: true, isDisabled: selectedTasks.isEmpty) {
                    onContinue()
                }

                VButton(label: "I'll set this up later", style: .ghost, tintColor: VColor.contentTertiary) {
                    onSkip()
                }
            }
        }
        .padding(.horizontal, VSpacing.xxl)
        .opacity(showContent ? 1 : 0)
        .offset(y: showContent ? 0 : 12)
        .onAppear {
            withAnimation(VAnimation.slow.delay(0.1)) {
                showTitle = true
            }
            withAnimation(VAnimation.slow.delay(0.3)) {
                showContent = true
            }
        }

        Spacer()
        }
    }

    // MARK: - Task Row

    @ViewBuilder
    private func taskRow(_ category: TaskCategory) -> some View {
        let isSelected = selectedTasks.contains(category.id)

        Button {
            withAnimation(VAnimation.fast) {
                if isSelected {
                    selectedTasks.remove(category.id)
                } else {
                    selectedTasks.insert(category.id)
                }
            }
        } label: {
            HStack(spacing: VSpacing.sm) {
                VIconView(category.icon, size: 16)
                    .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentSecondary)
                    .frame(width: 24, alignment: .center)

                VStack(alignment: .leading, spacing: 2) {
                    Text(category.label)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentDefault)

                    Text(category.sublabel)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                Spacer()

                ZStack {
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isSelected ? VColor.primaryBase : Color.clear)

                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .strokeBorder(isSelected ? Color.clear : VColor.borderElement, lineWidth: 1.5)

                    if isSelected {
                        VIconView(.check, size: 12)
                            .foregroundStyle(VColor.contentInset)
                    }
                }
                .frame(width: 20, height: 20)
            }
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .fill(isSelected ? VColor.primaryBase.opacity(0.08) : (hoveredTask == category.id ? VColor.surfaceBase : VColor.surfaceLift))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.lg)
                            .stroke(isSelected ? VColor.primaryBase.opacity(0.3) : (hoveredTask == category.id ? VColor.borderElement : VColor.surfaceBase), lineWidth: 1)
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor(onHover: { hovering in
            withAnimation(VAnimation.fast) {
                hoveredTask = hovering ? category.id : nil
            }
        })
        .accessibilityLabel(category.label)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(.isToggle)
    }
}
