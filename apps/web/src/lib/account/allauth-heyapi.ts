import { client } from "@/generated/auth/client.gen.js";
import { ensureCsrfCookie, getCsrfToken } from "@/lib/csrf.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function requestInterceptor(request: Request) {
    const newRequest = new Request(request);

    if (MUTATING_METHODS.has(request.method)) {
        await ensureCsrfCookie();
        const csrfToken = getCsrfToken();
        if (csrfToken) {
            newRequest.headers.set("X-CSRFToken", csrfToken);
        }
    }

    return newRequest;
}

client.interceptors.request.use(requestInterceptor);
