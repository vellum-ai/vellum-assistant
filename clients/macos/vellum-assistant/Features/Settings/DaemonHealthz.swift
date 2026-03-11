import Foundation

/// Health status response from the daemon's `/healthz` endpoint.
struct DaemonHealthz: Decodable {
    let status: String
    let timestamp: String?
    let version: String?
    let disk: DiskInfo?
    let memory: MemoryInfo?
    let cpu: CpuInfo?

    struct DiskInfo: Decodable {
        let path: String
        let totalMb: Double
        let usedMb: Double
        let freeMb: Double
    }

    struct MemoryInfo: Decodable {
        let currentMb: Double
        let maxMb: Double
    }

    struct CpuInfo: Decodable {
        let currentPercent: Double
        let maxCores: Int
    }
}

/// Fetches healthz data from the daemon's HTTP server or the platform proxy.
enum DaemonHealthzFetcher {

    /// Fetch healthz from a local daemon at the given port.
    static func fetchLocal(port: Int, bearerToken: String?) async -> DaemonHealthz? {
        guard let url = URL(string: "http://localhost:\(port)/healthz") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        if let token = bearerToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return await perform(request)
    }

    /// Fetch healthz via the platform proxy for a managed assistant.
    static func fetchManaged(
        baseURL: String,
        assistantId: String,
        sessionToken: String?,
        organizationId: String?
    ) async -> DaemonHealthz? {
        guard let token = sessionToken, !token.isEmpty else { return nil }
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/healthz/") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 5
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId = organizationId, !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        return await perform(request)
    }

    private static func perform(_ request: URLRequest) async -> DaemonHealthz? {
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(DaemonHealthz.self, from: data)
        } catch {
            return nil
        }
    }
}
