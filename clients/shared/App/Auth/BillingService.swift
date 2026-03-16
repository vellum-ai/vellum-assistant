import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "BillingService")

@MainActor
public final class BillingService {
    public static let shared = BillingService()

    private init() {}

    /// Fetch the current organization's billing summary.
    public func getBillingSummary() async throws -> BillingSummaryResponse {
        let urlString = "\(AuthService.shared.baseURL)/v1/organizations/billing/summary/"
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

    /// Bootstrap billing for organizations that don't have a BillingAccount yet.
    /// Calling POST on the summary endpoint creates the account with initial credit.
    public func bootstrapBillingSummary() async throws -> BillingSummaryResponse {
        let urlString = "\(AuthService.shared.baseURL)/v1/organizations/billing/summary/"
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

    /// Create a top-up checkout session and return the Stripe checkout URL.
    public func createTopUpCheckout(amountUsd: String) async throws -> URL {
        let urlString = "\(AuthService.shared.baseURL)/v1/organizations/billing/top-ups/checkout-session/"
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

        let requestBody = TopUpCheckoutRequest(amount_usd: amountUsd, return_path: "/billing/top-up/success")
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
}
