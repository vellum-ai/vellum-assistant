import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostCu")

// MARK: - Host CU Proxy Result Posting

extension HTTPTransport {

    /// Post the result of a host CU action execution back to the daemon.
    func postHostCuResult(_ result: HostCuResultPayload, isRetry: Bool = false) async {
        guard let url = buildURL(for: .hostCuResult) else {
            log.error("Failed to build URL for host_cu_result")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(result)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await postHostCuResult(result, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Host CU result failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Host CU result failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Host CU result error: \(error.localizedDescription)")
        }
    }
}
