import SwiftUI
import VellumAssistantShared

/// Inject Failures subsection of the Compaction Playground tab.
///
/// Directly mutates circuit-breaker state on the active conversation via
/// `CompactionPlaygroundClient.injectFailures(conversationId:consecutiveFailures:circuitOpenForMs:)`
/// so a developer can test UI reactions to compaction failures without having
/// to provoke real compaction errors. "Apply" sends whatever the two numeric
/// fields parse to (blank or garbage → `nil`, which leaves the corresponding
/// daemon-side value unchanged). "Trip Breaker Now" forces
/// `consecutiveFailures: 3, circuitOpenForMs: 3_600_000` regardless of the
/// field values so you can one-click reproduce an open circuit. A 404 from the
/// flat `/playground/*` routes (``CompactionPlaygroundError/notAvailable``)
/// surfaces a distinctive "flag off" toast so the dev can tell a disabled
/// playground apart from other failure modes.
struct InjectFailuresSection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let showToast: (String, ToastInfo.Style) -> Void

    @State private var failuresInput: String = "3"
    @State private var circuitMsInput: String = "3600000"
    @State private var isRunning = false
    @State private var lastState: CompactionStateResponse?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Inject Compaction Failures")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            Text("Directly set circuit-breaker state to test UI reactions to failures.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Consecutive failures")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                VTextField(
                    placeholder: "3",
                    text: $failuresInput
                )
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Circuit open for (ms)")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
                VTextField(
                    placeholder: "3600000",
                    text: $circuitMsInput
                )
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Apply",
                    style: .outlined,
                    isDisabled: conversationId == nil || isRunning
                ) {
                    runInject(
                        consecutiveFailures: parseOptionalInt(failuresInput),
                        circuitOpenForMs: parseOptionalInt(circuitMsInput)
                    )
                }

                VButton(
                    label: "Trip Breaker Now",
                    style: .primary,
                    isDisabled: conversationId == nil || isRunning
                ) {
                    runInject(
                        consecutiveFailures: 3,
                        circuitOpenForMs: 3_600_000
                    )
                }
            }

            if let state = lastState {
                Text(statusLine(for: state))
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    // MARK: - Helpers

    /// Parses a TextField into an optional `Int`.
    ///
    /// Blank input and non-integer garbage both map to `nil` — the UI intent
    /// for those cases is "leave this field unchanged", which matches the
    /// daemon's partial-update semantics for the inject-failures request.
    private func parseOptionalInt(_ raw: String) -> Int? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        return Int(trimmed)
    }

    /// Renders the post-action status line. `compactionCircuitOpenUntil` is
    /// a ms-since-epoch timestamp on the wire; format it as an ISO-8601
    /// string (no fractional seconds — we want a brief display).
    private func statusLine(for state: CompactionStateResponse) -> String {
        let openUntil: String
        if let msSinceEpoch = state.compactionCircuitOpenUntil {
            let date = Date(timeIntervalSince1970: Double(msSinceEpoch) / 1000.0)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime]
            openUntil = formatter.string(from: date)
        } else {
            openUntil = "—"
        }
        let circuit = state.isCircuitOpen ? "open" : "closed"
        return "Circuit: \(circuit), failures: \(state.consecutiveCompactionFailures), open until: \(openUntil)"
    }

    /// Fires the inject-failures request and refreshes `lastState` by
    /// calling `getState` on success. `injectFailures` itself returns
    /// nothing, so we round-trip once more to get the authoritative
    /// post-mutation state the daemon now reports.
    private func runInject(consecutiveFailures: Int?, circuitOpenForMs: Int?) {
        Task {
            guard let id = conversationId else { return }
            isRunning = true
            defer { isRunning = false }
            do {
                try await client.injectFailures(
                    conversationId: id,
                    consecutiveFailures: consecutiveFailures,
                    circuitOpenForMs: circuitOpenForMs
                )
                let state = try await client.getState(conversationId: id)
                lastState = state
                showToast("Circuit state updated.", .success)
            } catch CompactionPlaygroundError.notAvailable {
                showToast("Playground endpoints disabled — enable the compaction-playground flag.", .error)
            } catch {
                showToast("Inject failed: \(error.localizedDescription)", .error)
            }
        }
    }
}
