import AppKit
import SwiftUI
import VellumAssistantShared

/// Settings tab for configuring sound effects — global toggle, volume, and per-event sound selection.
struct SettingsSoundsTab: View {
    /// The sound manager singleton provides config, playback, and available sounds.
    private var soundManager: SoundManager { SoundManager.shared }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            globalSoundSection
            eventSoundSection
            helperTextSection
        }
    }

    // MARK: - Global Section

    private var globalSoundSection: some View {
        SettingsCard(title: "Sound Effects") {
            VToggle(
                isOn: Binding(
                    get: { soundManager.config.globalEnabled },
                    set: { newValue in
                        var updated = soundManager.config
                        updated.globalEnabled = newValue
                        soundManager.saveConfig(updated)
                    }
                ),
                label: "Enable sound effects"
            )

            SettingsDivider()

            HStack(spacing: VSpacing.md) {
                Text("Volume")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(soundManager.config.globalEnabled ? VColor.contentSecondary : VColor.contentDisabled)

                VSlider(
                    value: Binding(
                        get: { Double(soundManager.config.volume) },
                        set: { newValue in
                            var updated = soundManager.config
                            updated.volume = Float(newValue)
                            soundManager.saveConfig(updated)
                        }
                    ),
                    range: 0...1,
                    step: 0.05
                )
                .frame(maxWidth: 200)
            }
            .disabled(!soundManager.config.globalEnabled)

            SettingsDivider()

            VButton(
                label: "Preview",
                leftIcon: VIcon.play.rawValue,
                style: .outlined
            ) {
                previewDefaultBlip()
            }
        }
    }

    // MARK: - Per-Event Section

    private var eventSoundSection: some View {
        SettingsCard(title: "Sound Events") {
            let events = SoundEvent.allCases
            ForEach(Array(events.enumerated()), id: \.element) { index, event in
                if index > 0 {
                    SettingsDivider()
                }
                soundEventRow(for: event)
            }
        }
        .disabled(!soundManager.config.globalEnabled)
    }

    @ViewBuilder
    private func soundEventRow(for event: SoundEvent) -> some View {
        let eventConfig = soundManager.config.config(for: event)
        let sounds = soundManager.availableSounds()

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center) {
                Text(event.displayName)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Spacer()

                VToggle(
                    isOn: Binding(
                        get: { eventConfig.enabled },
                        set: { newValue in
                            var updated = soundManager.config
                            var ec = updated.config(for: event)
                            ec.enabled = newValue
                            updated.events[event.rawValue] = ec
                            soundManager.saveConfig(updated)
                        }
                    )
                )
            }

            soundPoolEditor(for: event, eventConfig: eventConfig, sounds: sounds)
                .disabled(!eventConfig.enabled)
        }
        .padding(.vertical, VSpacing.xs)
    }

    @ViewBuilder
    private func soundPoolEditor(
        for event: SoundEvent,
        eventConfig: SoundEventConfig,
        sounds: [(label: String, filename: String)]
    ) -> some View {
        // Build a lookup from filename → display label, mirroring `availableSounds()`
        // so a sound that was removed from the library still shows a readable name.
        let labelsByFilename = Dictionary(uniqueKeysWithValues: sounds.map { ($0.filename, $0.label) })

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            if eventConfig.sounds.isEmpty {
                // Empty-pool placeholder: shows the user that the default blip will play.
                HStack {
                    Text("Default Blip")
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.contentDisabled)
                    Spacer()
                }
                .frame(maxWidth: 220, alignment: .leading)
            } else {
                ForEach(Array(eventConfig.sounds.enumerated()), id: \.offset) { index, filename in
                    HStack(spacing: VSpacing.xs) {
                        let displayLabel = labelsByFilename[filename]
                            ?? (filename as NSString).deletingPathExtension
                        Text(displayLabel)
                            .font(VFont.bodyMediumLighter)
                            .foregroundStyle(VColor.contentDefault)
                            .lineLimit(1)
                            .truncationMode(.tail)

                        Spacer()

                        VButton(
                            label: "Preview sound",
                            iconOnly: VIcon.play.rawValue,
                            style: .ghost,
                            tooltip: "Preview sound"
                        ) {
                            soundManager.previewSound(filename: filename)
                        }

                        VButton(
                            label: "Remove sound",
                            iconOnly: VIcon.trash.rawValue,
                            style: .ghost,
                            tooltip: "Remove sound"
                        ) {
                            removeSound(at: index, for: event)
                        }
                    }
                    .frame(maxWidth: 220, alignment: .leading)
                }
            }

            let inPool = Set(eventConfig.sounds)
            let remainingOptions = sounds
                .filter { !inPool.contains($0.filename) }
                .map { (label: $0.label, value: $0.filename) }

            if sounds.isEmpty {
                // Library is empty — render a subtle hint instead of a misleading "All sounds added" dropdown.
                Text("No sound files yet")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentDisabled)
                    .frame(maxWidth: 220, alignment: .leading)
            } else if remainingOptions.isEmpty {
                // Every available sound is already in the pool — show a disabled dropdown
                // so the UI stays stable rather than visually jumping.
                VDropdown(
                    placeholder: "All sounds added",
                    selection: .constant(""),
                    options: [(label: "All sounds added", value: "")],
                    maxWidth: 220,
                    menuWidth: 260,
                    menuMaxHeight: 360
                )
                .disabled(true)
            } else {
                VDropdown(
                    placeholder: "Add sound…",
                    selection: Binding(
                        get: { "" },
                        set: { newValue in
                            guard !newValue.isEmpty else { return }
                            addSound(newValue, for: event)
                        }
                    ),
                    options: remainingOptions,
                    maxWidth: 220,
                    menuWidth: 260,
                    menuMaxHeight: 360
                )
            }
        }
        .frame(maxWidth: 220, alignment: .leading)
    }

    private func addSound(_ filename: String, for event: SoundEvent) {
        var updated = soundManager.config
        var ec = updated.config(for: event)
        guard !ec.sounds.contains(filename) else { return }
        ec.sounds.append(filename)
        updated.events[event.rawValue] = ec
        soundManager.saveConfig(updated)
    }

    private func removeSound(at index: Int, for event: SoundEvent) {
        var updated = soundManager.config
        var ec = updated.config(for: event)
        guard ec.sounds.indices.contains(index) else { return }
        ec.sounds.remove(at: index)
        updated.events[event.rawValue] = ec
        soundManager.saveConfig(updated)
    }

    // MARK: - Helper Text

    private var helperTextSection: some View {
        Text("Add one or more sounds per event. When multiple are configured, one plays at random.")
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)
    }

    // MARK: - Playback

    /// Preview the default blip at the current volume, bypassing enabled checks.
    private func previewDefaultBlip() {
        soundManager.previewDefaultBlip()
    }
}
