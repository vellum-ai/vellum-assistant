import SwiftUI
import VellumAssistantShared

struct SafeStorageAcknowledgementViewState: Equatable, Sendable {
    static let title = "Storage cleanup required"
    static let primaryActionLabel = "Acknowledge and clean up"
    static let backgroundProcessesBlockedCopy = "Background processes are disabled until enough space is freed by the guardian."
    static let trustedContactsBlockedCopy = "Messages from trusted contacts are blocked until enough space is freed by the guardian."

    let usageText: String
    let blockedCapabilityLabels: [String]
    let acknowledgementErrorMessage: String?

    var bodyText: String {
        "\(Self.backgroundProcessesBlockedCopy) \(Self.trustedContactsBlockedCopy)"
    }

    init?(
        status: DiskPressureStatus?,
        requiresAcknowledgement: Bool,
        acknowledgementErrorMessage: String? = nil
    ) {
        guard requiresAcknowledgement,
              let status,
              status.enabled,
              status.state != "disabled",
              status.effectivelyLocked,
              status.locked,
              !status.acknowledged
        else {
            return nil
        }

        self.usageText = SafeStorageCopy.usageText(for: status)
        self.blockedCapabilityLabels = SafeStorageCopy.blockedCapabilityLabels(for: status.blockedCapabilities)
        self.acknowledgementErrorMessage = Self.visibleErrorMessage(from: acknowledgementErrorMessage)
    }

    private static func visibleErrorMessage(from message: String?) -> String? {
        let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct SafeStorageCleanupStatusViewState: Equatable, Sendable {
    static let title = "Storage cleanup mode is active"
    static let actionLabel = "Open workspace"
    static let trustedContactBlockingCopy = SafeStorageAcknowledgementViewState.trustedContactsBlockedCopy
    static let backgroundBlockingCopy = SafeStorageAcknowledgementViewState.backgroundProcessesBlockedCopy

    let usageText: String
    let blockedCapabilityLabels: [String]

    var summaryText: String {
        "\(Self.backgroundBlockingCopy) \(Self.trustedContactBlockingCopy)"
    }

    init?(
        status: DiskPressureStatus?,
        isCleanupModeActive: Bool
    ) {
        guard isCleanupModeActive,
              let status,
              status.enabled,
              status.state != "disabled",
              status.effectivelyLocked,
              status.locked,
              status.acknowledged
        else {
            return nil
        }

        self.usageText = SafeStorageCopy.usageText(for: status)
        self.blockedCapabilityLabels = SafeStorageCopy.blockedCapabilityLabels(for: status.blockedCapabilities)
    }
}

struct MainWindowSafeStorageAcknowledgementActions {
    let acknowledge: () -> Void
    let focusCleanup: () -> Void

    func acknowledgeAndFocusCleanup() {
        acknowledge()
        focusCleanup()
    }

    func acknowledgeOnly() {
        acknowledge()
    }
}

struct MainWindowSafeStorageBanner: View {
    let status: DiskPressureStatus?
    let requiresAcknowledgement: Bool
    var acknowledgementErrorMessage: String? = nil
    let actions: MainWindowSafeStorageAcknowledgementActions

    var body: some View {
        if let state = SafeStorageAcknowledgementViewState(
            status: status,
            requiresAcknowledgement: requiresAcknowledgement,
            acknowledgementErrorMessage: acknowledgementErrorMessage
        ) {
            ZStack(alignment: .top) {
                VColor.auxBlack.opacity(0.22)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {}

                bannerCard(state)
                    .padding(.top, 84)
                    .padding(.horizontal, VSpacing.xxl)
            }
            .transition(.opacity)
            .accessibilityElement(children: .contain)
            .accessibilityLabel(SafeStorageAcknowledgementViewState.title)
            .layoutHangSignpost("mainWindow.safeStorageAcknowledgementBanner")
        }
    }

    private func bannerCard(_ state: SafeStorageAcknowledgementViewState) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            HStack(alignment: .top, spacing: VSpacing.md) {
                VIconView(.shieldAlert, size: 22)
                    .foregroundStyle(VColor.systemNegativeStrong)
                    .frame(width: 28, height: 28)

                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text(SafeStorageAcknowledgementViewState.title)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)

                    Text(state.usageText)
                        .font(VFont.bodyMediumEmphasised)
                        .foregroundStyle(VColor.contentDefault)

                    Text(state.bodyText)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .layoutPriority(1)

                VButton(
                    label: "Acknowledge and dismiss storage lock",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    size: .compact,
                    tooltip: "Dismiss and continue"
                ) {
                    actions.acknowledgeOnly()
                }
            }

            blockedCapabilitiesList(state.blockedCapabilityLabels)

            if let acknowledgementErrorMessage = state.acknowledgementErrorMessage {
                VNotification(acknowledgementErrorMessage, tone: .negative)
            }

            HStack(spacing: VSpacing.sm) {
                Spacer(minLength: 0)
                VButton(
                    label: SafeStorageAcknowledgementViewState.primaryActionLabel,
                    leftIcon: VIcon.folderOpen.rawValue,
                    style: .primary
                ) {
                    actions.acknowledgeAndFocusCleanup()
                }
            }
        }
        .padding(VSpacing.xl)
        .widthCap(720)
        .background(VColor.surfaceLift)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .strokeBorder(VColor.borderActive.opacity(0.35), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .vShadow(VShadow.lg)
    }

    private func blockedCapabilitiesList(_ labels: [String]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ForEach(labels, id: \.self) { label in
                HStack(spacing: VSpacing.xs) {
                    VIconView(.shieldBan, size: 13)
                        .foregroundStyle(VColor.systemNegativeStrong)
                    Text(label)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Blocked capabilities: \(labels.joined(separator: ", "))")
    }
}

struct SafeStorageCleanupStatusBanner: View {
    let state: SafeStorageCleanupStatusViewState
    let onOpenStorageCleanup: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VIconView(.hardDrive, size: 18)
                .foregroundStyle(VColor.systemNegativeStrong)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(SafeStorageCleanupStatusViewState.title)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentEmphasized)

                Text(state.usageText)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text(state.summaryText)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                FlowLayout(spacing: VSpacing.xs) {
                    ForEach(state.blockedCapabilityLabels, id: \.self) { label in
                        SafeStorageCapabilityChip(label: label)
                    }
                }
                .padding(.top, VSpacing.xs)
            }
            .layoutPriority(1)

            Spacer(minLength: VSpacing.sm)

            VButton(
                label: SafeStorageCleanupStatusViewState.actionLabel,
                leftIcon: VIcon.folderOpen.rawValue,
                style: .outlined,
                size: .compact
            ) {
                onOpenStorageCleanup()
            }
        }
        .padding(VSpacing.lg)
        .background(VColor.systemNegativeWeak.opacity(0.55))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .strokeBorder(VColor.systemNegativeStrong.opacity(0.32), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(SafeStorageCleanupStatusViewState.title)
        .accessibilityValue("\(state.usageText). \(state.summaryText)")
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .layoutHangSignpost("chat.safeStorageCleanupStatusBanner")
    }
}

private struct SafeStorageCapabilityChip: View {
    let label: String

    var body: some View {
        HStack(spacing: VSpacing.xxs) {
            VIconView(.lock, size: 10)
            Text(label)
                .font(VFont.labelDefault)
        }
        .foregroundStyle(VColor.contentDefault)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(VColor.surfaceBase.opacity(0.75))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.chip))
    }
}

private enum SafeStorageCopy {
    private static let mandatoryLabels = [
        "Background processes disabled",
        "Trusted-contact messages blocked",
    ]

    static func usageText(for status: DiskPressureStatus) -> String {
        let threshold = formattedPercent(status.thresholdPercent)
        let location = status.path.map { " at \($0)" } ?? ""
        guard let usagePercent = status.usagePercent else {
            return "Storage is critically low\(location). Critical threshold is \(threshold)."
        }
        return "Storage is \(formattedPercent(usagePercent)) full\(location). Critical threshold is \(threshold)."
    }

    static func blockedCapabilityLabels(for capabilities: [String]) -> [String] {
        var labels = capabilities.map(label(for:))
        labels.append(contentsOf: mandatoryLabels)
        return labels.reduce(into: []) { result, label in
            guard !result.contains(label) else { return }
            result.append(label)
        }
    }

    private static func label(for capability: String) -> String {
        switch capability {
        case "agent-turns", "normal-agent-turns":
            return "Normal assistant work paused"
        case "background", "background-processes", "background-work":
            return "Background processes disabled"
        case "messages", "remote-ingress", "trusted-contact", "trusted-contact-messages":
            return "Trusted-contact messages blocked"
        default:
            return capability
                .split(separator: "-")
                .map { word in
                    guard let first = word.first else { return "" }
                    return first.uppercased() + word.dropFirst()
                }
                .joined(separator: " ")
        }
    }

    private static func formattedPercent(_ value: Double) -> String {
        "\(Int(value.rounded()))%"
    }
}
