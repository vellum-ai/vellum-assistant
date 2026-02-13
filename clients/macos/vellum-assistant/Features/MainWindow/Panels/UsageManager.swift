import SwiftUI

@MainActor
final class UsageManager: ObservableObject {
    @Published var summary: UsageSummaryResponseMessage?
    @Published var budgetStatus: BudgetStatusResponseMessage?
    @Published var budgetWarnings: [BudgetWarningMessage.BudgetWarningViolation] = []
    @Published var isLoading = false
    @Published var selectedPreset: String = "24h"

    private let daemonClient: DaemonClient
    private var warningSubscriptionTask: Task<Void, Never>?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func fetchSummary() {
        guard !isLoading else { return }
        isLoading = true

        Task {
            // Subscribe before sending so we don't miss fast daemon responses
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(UsageSummaryRequestMessage(preset: selectedPreset))
            } catch {
                isLoading = false
                return
            }

            for await message in stream {
                if case .usageSummaryResponse(let response) = message {
                    summary = response
                    isLoading = false
                    return
                }
            }
            isLoading = false
        }
    }

    func fetchBudgetStatus() {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(BudgetStatusRequestMessage())
            } catch {
                return
            }

            for await message in stream {
                if case .budgetStatusResponse(let response) = message {
                    budgetStatus = response
                    return
                }
            }
        }
    }

    func subscribeToBudgetWarnings() {
        warningSubscriptionTask?.cancel()
        warningSubscriptionTask = Task {
            let stream = daemonClient.subscribe()
            for await message in stream {
                if case .budgetWarning(let warning) = message {
                    budgetWarnings = warning.violations
                }
            }
        }
    }
}
