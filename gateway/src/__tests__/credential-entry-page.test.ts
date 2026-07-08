import { describe, expect, test } from "bun:test";

import { handleCredentialEntryPage } from "../http/routes/credential-entry-page.js";

describe("credential entry page", () => {
  test("serves a self-contained HTML page with no-store and no-referrer", async () => {
    const res = handleCredentialEntryPage(
      new Request("http://gateway.local/assistant/credentials/enter"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");

    const html = await res.text();
    // The page reads the token from the fragment and calls the public
    // credential-request routes with a path prefix derived from its own URL
    // (Velay-style /<assistantId>/... prefixes included).
    expect(html).toContain("location.hash");
    expect(html).toContain("/v1/credential-requests/peek");
    expect(html).toContain("/v1/credential-requests/submit");
    expect(html).toContain("history.replaceState");
    // Fully static template: no external asset references.
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('href="http');
  });

  test("rejects non-GET methods", () => {
    const res = handleCredentialEntryPage(
      new Request("http://gateway.local/assistant/credentials/enter", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(405);
  });
});
