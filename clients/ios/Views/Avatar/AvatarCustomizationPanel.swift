#if canImport(UIKit)
import SwiftUI
import PhotosUI
import VellumAssistantShared

/// View for customizing the avatar's appearance on iOS.
/// Designed to be pushed onto a NavigationStack (e.g. via NavigationLink in SettingsView).
/// Users can pick body/cheek colors, outfit items, and lock individual fields
/// so auto-evolution won't override them.
struct AvatarCustomizationPanel: View {
    @State private var appearance = AvatarAppearanceManager.shared
    @State private var evolutionState = AvatarEvolutionState()
    @State private var expandedField: AvatarEvolutionState.AppearanceField?
    @State private var photoPickerItem: PhotosPickerItem?
    @State private var customImageData: Data?

    /// All available color names from BodyColorScale, in a stable display order.
    private let colorNames: [String] = [
        "violet", "indigo", "blue", "cyan",
        "emerald", "green", "rose", "pink",
        "red", "orange", "amber", "slate"
    ]

    /// Available outfit options per field.
    private let hatOptions = ["none", "top_hat", "crown", "cap", "beanie", "wizard_hat", "cowboy_hat"]
    private let shirtOptions = ["none", "tshirt", "suit", "hoodie", "tank_top", "sweater"]
    private let accessoryOptions = ["none", "sunglasses", "monocle", "bowtie", "necklace", "scarf", "cape"]
    private let heldItemOptions = ["none", "sword", "staff", "shield", "balloon"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                // Live avatar preview
                avatarPreview

                // Profile picture section
                profilePictureSection

                // Body Color section
                colorGridSection(
                    title: "Body Color",
                    field: .bodyColor,
                    selectedColor: evolutionState.userOverrides[.bodyColor] ?? appearance.config.bodyColor
                )

                // Cheek Color section
                colorGridSection(
                    title: "Cheek Color",
                    field: .cheekColor,
                    selectedColor: evolutionState.userOverrides[.cheekColor] ?? appearance.config.cheekColor
                )

                // Outfit section
                outfitSection
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.top, VSpacing.md)
            .padding(.bottom, VSpacing.xxl)
        }
        .background(VColor.backgroundSubtle)
        .navigationTitle("Customize Avatar")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    resetToAuto()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.counterclockwise")
                            .font(.system(size: 12, weight: .medium))
                        Text("Reset")
                            .font(VFont.bodyMedium)
                    }
                    .foregroundColor(VColor.textSecondary)
                }
            }
        }
        .onAppear {
            evolutionState.load()
            appearance.start()
        }
        .onChange(of: photoPickerItem) { _, newItem in
            Task {
                guard let item = newItem,
                      let data = try? await item.loadTransferable(type: Data.self) else { return }
                customImageData = data
                saveCustomAvatarData(data)
            }
        }
    }

    // MARK: - Avatar Preview

    @ViewBuilder
    private var avatarPreview: some View {
        HStack {
            Spacer()
            EvolvingAvatarView(
                evolutionState: evolutionState,
                animated: false
            )
            .frame(width: 140, height: 160)
            Spacer()
        }
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Profile Picture

    @ViewBuilder
    private var profilePictureSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Profile Picture")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            if let imageData = customImageData,
               let uiImage = UIImage(data: imageData) {
                HStack(spacing: VSpacing.md) {
                    Image(uiImage: uiImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 48, height: 48)
                        .clipShape(Circle())

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        PhotosPicker(selection: $photoPickerItem, matching: .images) {
                            Text("Change")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.accent)
                        }

                        Button("Remove") {
                            customImageData = nil
                            clearCustomAvatarData()
                        }
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textMuted)
                    }
                }
            } else {
                PhotosPicker(selection: $photoPickerItem, matching: .images) {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "photo")
                            .font(.system(size: 12, weight: .medium))
                        Text("Upload Custom Image")
                            .font(VFont.bodyMedium)
                    }
                    .foregroundColor(VColor.textSecondary)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.sm)
                    .background(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                }
            }
        }
        .onAppear {
            loadCustomAvatarData()
        }
    }

    // MARK: - Color Grid Section

    @ViewBuilder
    private func colorGridSection(title: String, field: AvatarEvolutionState.AppearanceField, selectedColor: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            fieldHeader(title: title, field: field)

            let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.sm), count: 6)
            LazyVGrid(columns: columns, spacing: VSpacing.sm) {
                ForEach(colorNames, id: \.self) { name in
                    colorCircle(name: name, isSelected: selectedColor == name) {
                        setOverride(field: field, value: name)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func colorCircle(name: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        let displayColor = swiftUIColor(for: name)
        Button(action: action) {
            Circle()
                .fill(displayColor)
                .frame(width: 36, height: 36)
                .overlay(
                    Circle()
                        .stroke(isSelected ? Color.white : Color.clear, lineWidth: 2)
                )
                .overlay(
                    Circle()
                        .stroke(isSelected ? displayColor : Color.clear, lineWidth: 1)
                        .padding(3)
                )
                .shadow(color: isSelected ? displayColor.opacity(0.4) : .clear, radius: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name) color\(isSelected ? ", selected" : "")")
    }

    /// Convert a color scale name to a SwiftUI Color using the mid shade from BodyColorScale.
    private func swiftUIColor(for name: String) -> Color {
        guard let scale = BodyColorScale.scales[name] else { return Color.gray }
        return Color(hex: UInt(scale.mid))
    }

    // MARK: - Outfit Section

    @ViewBuilder
    private var outfitSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Outfit")
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            outfitPicker(title: "Hat", field: .hat, options: hatOptions,
                         current: evolutionState.userOverrides[.hat] ?? appearance.config.hat)
            outfitPicker(title: "Shirt", field: .shirt, options: shirtOptions,
                         current: evolutionState.userOverrides[.shirt] ?? appearance.config.shirt)
            outfitPicker(title: "Accessory", field: .accessory, options: accessoryOptions,
                         current: evolutionState.userOverrides[.accessory] ?? appearance.config.accessory)
            outfitPicker(title: "Held Item", field: .heldItem, options: heldItemOptions,
                         current: evolutionState.userOverrides[.heldItem] ?? appearance.config.heldItem)
        }
    }

    @ViewBuilder
    private func outfitPicker(title: String, field: AvatarEvolutionState.AppearanceField, options: [String], current: String) -> some View {
        let isExpanded = expandedField == field
        HStack(spacing: VSpacing.sm) {
            lockToggle(field: field)

            Text(title)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(width: 90, alignment: .leading)

            Button {
                withAnimation(VAnimation.fast) {
                    expandedField = isExpanded ? nil : field
                }
            } label: {
                HStack {
                    Text(current.replacingOccurrences(of: "_", with: " ").capitalized)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)
                    Spacer()
                    Image(systemName: "chevron.up")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(VColor.textMuted)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
            }
            .buttonStyle(.plain)
            .overlay(alignment: .bottom) {
                if isExpanded {
                    VStack(spacing: 0) {
                        ForEach(options, id: \.self) { option in
                            Button {
                                setOverride(field: field, value: option)
                                withAnimation(VAnimation.fast) {
                                    expandedField = nil
                                }
                            } label: {
                                HStack {
                                    Text(option.replacingOccurrences(of: "_", with: " ").capitalized)
                                        .font(VFont.body)
                                        .foregroundColor(option == current ? VColor.accent : VColor.textPrimary)
                                    Spacer()
                                    if option == current {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 11, weight: .semibold))
                                            .foregroundColor(VColor.accent)
                                    }
                                }
                                .padding(.horizontal, VSpacing.md)
                                .padding(.vertical, VSpacing.sm)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .background(option == current ? VColor.accent.opacity(0.1) : Color.clear)

                            if option != options.last {
                                Divider().background(VColor.surfaceBorder)
                            }
                        }
                    }
                    .background(VColor.surface)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.surfaceBorder, lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.2), radius: 8, y: -2)
                    .offset(y: -VSpacing.xs)
                    .frame(maxWidth: .infinity)
                    .alignmentGuide(.bottom) { d in d[.bottom] }
                    .transition(.opacity)
                }
            }
            .zIndex(isExpanded ? 1 : 0)
        }
        .zIndex(isExpanded ? 1 : 0)
    }

    // MARK: - Field Header with Lock

    @ViewBuilder
    private func fieldHeader(title: String, field: AvatarEvolutionState.AppearanceField) -> some View {
        HStack(spacing: VSpacing.sm) {
            lockToggle(field: field)

            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)
        }
    }

    @ViewBuilder
    private func lockToggle(field: AvatarEvolutionState.AppearanceField) -> some View {
        let isLocked = evolutionState.lockedFields.contains(field)
        Button {
            toggleLock(field: field)
        } label: {
            Image(systemName: isLocked ? "lock.fill" : "lock.open")
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(isLocked ? VColor.accent : VColor.textMuted)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isLocked ? "Unlock \(field.rawValue)" : "Lock \(field.rawValue)")
    }

    // MARK: - Custom Avatar Persistence (iOS)

    private var customAvatarURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("custom-avatar.png")
    }

    private func loadCustomAvatarData() {
        guard FileManager.default.fileExists(atPath: customAvatarURL.path),
              let data = try? Data(contentsOf: customAvatarURL) else { return }
        customImageData = data
    }

    private func saveCustomAvatarData(_ data: Data) {
        let dir = customAvatarURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: customAvatarURL)
    }

    private func clearCustomAvatarData() {
        try? FileManager.default.removeItem(at: customAvatarURL)
    }

    // MARK: - Actions

    /// Set an override value and auto-lock the field.
    private func setOverride(field: AvatarEvolutionState.AppearanceField, value: String) {
        evolutionState.userOverrides[field] = value
        evolutionState.lockedFields.insert(field)
        resolveAndApply()
    }

    /// Toggle lock on a field. Unlocking removes the override so the resolver
    /// falls back to trait-based values and auto-evolution can control the field.
    private func toggleLock(field: AvatarEvolutionState.AppearanceField) {
        if evolutionState.lockedFields.contains(field) {
            evolutionState.lockedFields.remove(field)
            evolutionState.userOverrides.removeValue(forKey: field)
        } else {
            evolutionState.lockedFields.insert(field)
        }
        resolveAndApply()
    }

    /// Clear all overrides and unlock all fields, then re-resolve.
    private func resetToAuto() {
        evolutionState.userOverrides.removeAll()
        evolutionState.lockedFields.removeAll()
        resolveAndApply()
    }

    /// Resolve the current state and apply the result to the appearance manager.
    private func resolveAndApply() {
        let resolved = AvatarEvolutionResolver.resolve(state: evolutionState)
        AvatarAppearanceManager.shared.applyEvolutionResult(resolved)
        evolutionState.save()
    }
}

#Preview {
    AvatarCustomizationPanel()
}
#endif
