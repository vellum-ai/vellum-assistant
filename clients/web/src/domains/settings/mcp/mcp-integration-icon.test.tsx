import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { McpIntegrationIcon } from "./mcp-integration-icon";

afterEach(cleanup);

describe("MCP integration branding", () => {
  test.each([
    "fathom",
    "brex",
    "ramp",
    "linear",
    "notion",
    "sentry",
    "stripe",
    "atlassian",
  ])("uses bundled branding for %s", (providerKey) => {
    const { container } = render(
      <McpIntegrationIcon
        providerKey={providerKey}
        endpointUrl="https://api.example.com/mcp"
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "images/integrations/",
    );
    expect(container.querySelector("img")?.getAttribute("src")).not.toContain(
      "api.example.com",
    );
  });

  test("tries brand, supplied icon, favicon, then a fixed-size generic icon", () => {
    const { container } = render(
      <McpIntegrationIcon
        providerKey="fathom"
        logoUrl="https://icons.example.com/plugin.png"
        endpointUrl="https://api.example.com/mcp?account=example"
      />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "fathom.png",
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://icons.example.com/plugin.png",
    );
    fireEvent.error(container.querySelector("img")!);
    const favicon = container.querySelector("img")!;
    expect(favicon.getAttribute("src")).toBe(
      "https://api.example.com/favicon.ico",
    );
    expect(favicon.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(favicon.width).toBe(32);
    fireEvent.error(favicon);
    expect(container.querySelector("img")).toBeNull();
    const generic = container.querySelector("span")!;
    expect(generic.style.width).toBe("32px");
    expect(generic.style.height).toBe("32px");
    expect(generic.getAttribute("aria-hidden")).toBe("true");
    expect(generic.querySelector("svg")).not.toBeNull();
  });

  test("retries a changed candidate set without keeping a stale image failure", () => {
    const { container, rerender } = render(
      <McpIntegrationIcon endpointUrl="https://first.example.com/mcp" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(
      <McpIntegrationIcon endpointUrl="https://second.example.com/mcp" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://second.example.com/favicon.ico",
    );
    fireEvent.error(container.querySelector("img")!);
    rerender(
      <McpIntegrationIcon endpointUrl="https://first.example.com/mcp" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://first.example.com/favicon.ico",
    );
  });

  test("does not infer a bundled brand from the endpoint", () => {
    const { container } = render(
      <McpIntegrationIcon endpointUrl="https://api.fathom.ai/mcp" />,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://api.fathom.ai/favicon.ico",
    );
  });

  test("uses the generic plugin icon for stdio or private endpoints", () => {
    const { container, rerender } = render(<McpIntegrationIcon />);
    expect(container.querySelector("img")).toBeNull();
    rerender(
      <McpIntegrationIcon endpointUrl="https://10.0.0.2/mcp" size={40} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("span")?.style.width).toBe("40px");
  });
});
