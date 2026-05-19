import { describe, expect, test } from "bun:test";

import {
  buildCallSiteMetadataMap,
  type UsageCallSiteCatalogResponse,
} from "@/lib/usage/call-site-metadata.js";

describe("buildCallSiteMetadataMap", () => {
  test("indexes mainAgent to Main Agent", () => {
    const map = buildCallSiteMetadataMap({
      domains: [],
      callSites: [
        {
          id: "mainAgent",
          displayName: "Main Agent",
          description: "",
          domain: "",
        },
      ],
    });

    expect(map.mainAgent?.displayName).toBe("Main Agent");
  });

  test("preserves description and domain", () => {
    const map = buildCallSiteMetadataMap({
      domains: [{ id: "chat", displayName: "Chat" }],
      callSites: [
        {
          id: "mainAgent",
          displayName: "Main Agent",
          description: "Handles the primary assistant turn.",
          domain: "chat",
        },
      ],
    });

    expect(map.mainAgent).toEqual({
      id: "mainAgent",
      displayName: "Main Agent",
      description: "Handles the primary assistant turn.",
      domain: "chat",
    });
  });

  test("ignores entries with missing IDs or labels", () => {
    const catalog = {
      domains: [],
      callSites: [
        {
          id: "",
          displayName: "Missing ID",
          description: "Ignored",
          domain: "chat",
        },
        {
          id: "missingLabel",
          displayName: "",
          description: "Ignored",
          domain: "chat",
        },
        {
          displayName: "No ID",
          description: "Ignored",
          domain: "chat",
        },
        {
          id: "noLabel",
          description: "Ignored",
          domain: "chat",
        },
        {
          id: "mainAgent",
          displayName: "Main Agent",
          description: 123,
          domain: null,
        },
      ],
    } as unknown as UsageCallSiteCatalogResponse;

    expect(buildCallSiteMetadataMap(catalog)).toEqual({
      mainAgent: {
        id: "mainAgent",
        displayName: "Main Agent",
        description: "",
        domain: "",
      },
    });
  });

  test("returns an empty map for null or undefined catalog input", () => {
    expect(buildCallSiteMetadataMap(null)).toEqual({});
    expect(buildCallSiteMetadataMap(undefined)).toEqual({});
  });

  test("returns an empty map when callSites is missing", () => {
    const catalog = { domains: [] } as unknown as UsageCallSiteCatalogResponse;

    expect(buildCallSiteMetadataMap(catalog)).toEqual({});
  });
});
