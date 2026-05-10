import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "BillingService")

@MainActor
public final class BillingService {
    public static let shared = BillingService()

    /// In-flight bootstrap tasks keyed by org ID to prevent concurrent calls per org.
    private var bootstrapTasks: [String: Task<BillingSummaryResponse?, Never>] = [:]

    private init() {}

    /// Key used to persist that billing bootstrap has been attempted for a given org.
    private func bootstrapKey(for orgId: String) -> String {
        "billingBootstrapAttempted_\(orgId)"
    }

    /// Fetch the current organization's billing summary.
    public func getBillingSummary() async throws -> BillingSummaryResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/billing/summary/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET organizations/billing/summary/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(BillingSummaryResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Bootstrap billing if this org hasn't been bootstrapped yet.
    /// Returns the bootstrapped summary, or nil if bootstrap was already attempted or not needed.
    /// Uses a local UserDefaults flag per org + in-flight task dedup to ensure bootstrap
    /// fires at most once per organization, preventing repeated POSTs for depleted accounts.
    public func bootstrapBillingSummaryIfNeeded(summary: BillingSummaryResponse) async -> BillingSummaryResponse? {
        guard let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else { return nil }

        // Only attempt bootstrap for all-zero balances
        let isAllZero = summary.effective_balance == "0.00"
            && summary.settled_balance == "0.00"
            && summary.pending_compute == "0.00"
        guard isAllZero else { return nil }

        // Skip if we've already attempted bootstrap for this org
        guard !UserDefaults.standard.bool(forKey: bootstrapKey(for: orgId)) else { return nil }

        // Deduplicate concurrent bootstrap calls for the same org
        if let existing = bootstrapTasks[orgId] {
            return await existing.value
        }

        let task = Task<BillingSummaryResponse?, Never> {
            do {
                let result = try await postBootstrapBillingSummary()
                // Only persist the flag on success so transient failures don't permanently suppress retries
                UserDefaults.standard.set(true, forKey: bootstrapKey(for: orgId))
                return result
            } catch {
                log.error("Billing bootstrap failed: \(error.localizedDescription)")
                return nil
            }
        }
        bootstrapTasks[orgId] = task
        let result = await task.value
        // Safe to clear unconditionally: @MainActor serialization guarantees no concurrent
        // mutation between the await resumption and this line.
        bootstrapTasks[orgId] = nil
        return result
    }

    /// POST to the billing summary endpoint to create the BillingAccount with initial credit.
    private func postBootstrapBillingSummary() async throws -> BillingSummaryResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/billing/summary/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = "{}".data(using: .utf8)

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST organizations/billing/summary/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(BillingSummaryResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Fetch the current user's referral code and stats.
    /// The backend lazily creates a referral code if one doesn't exist yet.
    public func getReferralCode() async throws -> ReferralCodeResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/referral-codes/me/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET referral-codes/me/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(ReferralCodeResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Create a top-up checkout session and return the Stripe checkout URL.
    public func createTopUpCheckout(amount: String) async throws -> URL {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/billing/top-ups/checkout-session/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let requestBody = TopUpCheckoutRequest(amount: amount, return_path: "/billing/top-up/success")
        let encoder = JSONEncoder()
        urlRequest.httpBody = try encoder.encode(requestBody)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request POST organizations/billing/top-ups/checkout-session/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        let checkoutResponse: TopUpCheckoutResponse
        do {
            checkoutResponse = try JSONDecoder().decode(TopUpCheckoutResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }

        guard let checkoutURL = URL(string: checkoutResponse.checkout_url) else {
            throw PlatformAPIError.invalidURL
        }

        return checkoutURL
    }

    /// Fetch the current organization's subscription state.
    public func getSubscription() async throws -> SubscriptionResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/billing/subscription/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET organizations/billing/subscription/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(SubscriptionResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }

    /// Fetch the static plan catalog (Base + Pro).
    public func getPlanCatalog() async throws -> PlanCatalogResponse {
        let urlString = "\(VellumEnvironment.resolvedPlatformURL)/v1/organizations/billing/plans/"
        guard let url = URL(string: urlString) else {
            throw PlatformAPIError.invalidURL
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        if let token = await SessionTokenManager.getTokenAsync() {
            urlRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
        } else {
            throw PlatformAPIError.authenticationRequired
        }

        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId") else {
            throw PlatformAPIError.authenticationRequired
        }
        urlRequest.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw PlatformAPIError.networkError(error.localizedDescription)
        }

        let httpResponse = response as? HTTPURLResponse
        let statusCode = httpResponse?.statusCode ?? 0

        log.debug("Platform request GET organizations/billing/plans/ -> \(statusCode)")

        if statusCode == 401 || statusCode == 403 {
            throw PlatformAPIError.authenticationRequired
        }

        guard (200..<300).contains(statusCode) else {
            let detail = String(data: data, encoding: .utf8)
            throw PlatformAPIError.serverError(statusCode: statusCode, detail: detail)
        }

        do {
            return try JSONDecoder().decode(PlanCatalogResponse.self, from: data)
        } catch {
            throw PlatformAPIError.decodingError(error.localizedDescription)
        }
    }
}
