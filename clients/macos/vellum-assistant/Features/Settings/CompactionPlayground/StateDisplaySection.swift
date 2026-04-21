import SwiftUI
import VellumAssistantShared

/// Compaction-state display for the Compaction Playground settings tab.
///
/// Polls ``CompactionPlaygroundClient/getState(conversationId:)`` every 5s
/// while visible and on every `conversationId` change. Renders a token gauge
/// (colored per ``VContextWindowIndicator``'s palette) and a key-value grid
/// of every field on ``CompactionStateResponse``. A "Refresh" button triggers
/// an immediate reload. Polling is cancelled in `onDisappear`.
struct StateDisplaySection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient

    @State private var state: CompactionStateResponse?
    @State private var pollTask: Task<Void, Never>?
    @State private var lastError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Compaction State")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            contentBody
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
        .onAppear { startPolling() }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
        .onChange(of: conversationId) { _, _ in
            state = nil
            lastError = nil
            startPolling()
        }
    }

    @ViewBuilder
    private var contentBody: some View {
        if conversationId == nil {
            Text("No active conversation.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        } else if let state {
            tokenGauge(for: state)
            fieldsGrid(for: state)
            refreshButton
        } else if let lastError {
            Text(lastError)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
            refreshButton
        } else {
            Text("Loading…")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
    }

    // MARK: - Token gauge

    @ViewBuilder
    private func tokenGauge(for state: CompactionStateResponse) -> some View {
        let rawRatio: Double = state.maxInputTokens > 0
            ? Double(state.estimatedInputTokens) / Double(state.maxInputTokens)
            : 0
        let ratio = min(max(rawRatio, 0), 1)
        let thresholdRatio = min(max(state.compactThresholdRatio, 0), 1)
        let gaugeHeight: CGFloat = 12

        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("\(state.estimatedInputTokens) / \(state.maxInputTokens) tokens (threshold \(Int(state.compactThresholdRatio * 100))%)")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            GeometryReader { proxy in
                let width = proxy.size.width
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: gaugeHeight / 2)
                        .fill(VColor.contentTertiary.opacity(0.2))

                    RoundedRectangle(cornerRadius: gaugeHeight / 2)
                        .fill(gaugeColor(for: ratio))
                        .frame(width: width * CGFloat(ratio))

                    Rectangle()
                        .fill(VColor.contentDefault)
                        .frame(width: 2, height: gaugeHeight + 4)
                        .offset(x: width * CGFloat(thresholdRatio) - 1, y: 0)
                }
            }
            .frame(height: gaugeHeight)
        }
    }

    /// Matches the palette in ``VContextWindowIndicator`` (see
    /// `clients/shared/DesignSystem/Components/Feedback/VContextWindowIndicator.swift`
    /// around lines 29-34).
    private func gaugeColor(for ratio: Double) -> Color {
        if ratio >= 0.8 { return VColor.systemNegativeStrong }
        if ratio >= 0.6 { return VColor.systemMidStrong }
        return VColor.contentTertiary
    }

    // MARK: - Field grid

    @ViewBuilder
    private func fieldsGrid(for state: CompactionStateResponse) -> some View {
        let columns = [
            GridItem(.flexible(), alignment: .leading),
            GridItem(.flexible(), alignment: .leading),
        ]

        LazyVGrid(columns: columns, alignment: .leading, spacing: VSpacing.xs) {
            fieldLabel("Message count")
            fieldValue("\(state.messageCount)")

            fieldLabel("Compacted message count")
            fieldValue("\(state.contextCompactedMessageCount)")

            fieldLabel("Context compacted at")
            fieldValue(Self.formatTimestamp(state.contextCompactedAt))

            fieldLabel("Consecutive failures")
            fieldValue("\(state.consecutiveCompactionFailures)")

            fieldLabel("Circuit open until")
            fieldValue(Self.formatTimestamp(state.compactionCircuitOpenUntil))

            fieldLabel("Is circuit open")
            yesNoValue(state.isCircuitOpen, trueIsBad: true)

            fieldLabel("Is compaction enabled")
            yesNoValue(state.isCompactionEnabled, trueIsBad: false)
        }
    }

    @ViewBuilder
    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(VFont.bodySmallDefault)
            .foregroundStyle(VColor.contentSecondary)
    }

    @ViewBuilder
    private func fieldValue(_ text: String) -> some View {
        Text(text)
            .font(VFont.bodySmallDefault)
            .foregroundStyle(VColor.contentDefault)
    }

    @ViewBuilder
    private func yesNoValue(_ value: Bool, trueIsBad: Bool) -> some View {
        let color: Color = trueIsBad
            ? (value ? VColor.systemNegativeStrong : VColor.systemPositiveStrong)
            : (value ? VColor.systemPositiveStrong : VColor.systemNegativeStrong)
        Text(value ? "yes" : "no")
            .font(VFont.bodySmallDefault)
            .foregroundStyle(color)
    }

    // MARK: - Refresh

    @ViewBuilder
    private var refreshButton: some View {
        HStack {
            Spacer()
            VButton(label: "Refresh", style: .outlined, size: .compact) {
                Task { await refresh() }
            }
        }
    }

    // MARK: - Formatting helpers

    private static let timestampFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()

    private static func formatTimestamp(_ msSinceEpoch: Int?) -> String {
        guard let ms = msSinceEpoch else { return "—" }
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        return timestampFormatter.string(from: date)
    }

    // MARK: - Polling

    private func startPolling() {
        pollTask?.cancel()
        guard conversationId != nil else {
            pollTask = nil
            return
        }
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func refresh() async {
        guard let id = conversationId else { return }
        do {
            state = try await client.getState(conversationId: id)
            lastError = nil
        } catch CompactionPlaygroundError.notAvailable {
            lastError = "Playground endpoints disabled."
        } catch {
            lastError = error.localizedDescription
        }
    }
}
