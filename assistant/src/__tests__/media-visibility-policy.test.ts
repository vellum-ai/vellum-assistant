import { describe, expect, test } from "bun:test";

import {
  type AttachmentContext,
  filterVisibleAttachments,
  isAttachmentVisible,
} from "../daemon/media-visibility-policy.js";

// ---------------------------------------------------------------------------
// isAttachmentVisible
// ---------------------------------------------------------------------------

describe("isAttachmentVisible", () => {
  const standardAttachment: AttachmentContext = {
    conversationId: "conv-standard-001",
    isPrivate: false,
  };

  const privateAttachmentA: AttachmentContext = {
    conversationId: "conv-private-aaa",
    isPrivate: true,
  };

  const privateAttachmentB: AttachmentContext = {
    conversationId: "conv-private-bbb",
    isPrivate: true,
  };

  describe("standard conversation attachments", () => {
    test("visible from a standard conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: "conv-other",
        isPrivate: false,
      };
      expect(isAttachmentVisible(standardAttachment, ctx)).toBe(true);
    });

    test("visible from a different standard conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: "conv-standard-002",
        isPrivate: false,
      };
      expect(isAttachmentVisible(standardAttachment, ctx)).toBe(true);
    });

    test("visible from a private conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: "conv-private-xyz",
        isPrivate: true,
      };
      expect(isAttachmentVisible(standardAttachment, ctx)).toBe(true);
    });

    test("visible when isPrivate is explicitly false", () => {
      const attachment: AttachmentContext = {
        conversationId: "conv-001",
        isPrivate: false,
      };
      const ctx: AttachmentContext = {
        conversationId: "conv-002",
        isPrivate: false,
      };
      expect(isAttachmentVisible(attachment, ctx)).toBe(true);
    });
  });

  describe("private conversation attachments", () => {
    test("visible from the same private conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: privateAttachmentA.conversationId,
        isPrivate: true,
      };
      expect(isAttachmentVisible(privateAttachmentA, ctx)).toBe(true);
    });

    test("NOT visible from a different private conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: privateAttachmentB.conversationId,
        isPrivate: true,
      };
      expect(isAttachmentVisible(privateAttachmentA, ctx)).toBe(false);
    });

    test("NOT visible from a standard conversation", () => {
      const ctx: AttachmentContext = {
        conversationId: "conv-standard-001",
        isPrivate: false,
      };
      expect(isAttachmentVisible(privateAttachmentA, ctx)).toBe(false);
    });

    test("NOT visible when context is standard (isPrivate false)", () => {
      const ctx: AttachmentContext = {
        conversationId: privateAttachmentA.conversationId,
        isPrivate: false,
      };
      expect(isAttachmentVisible(privateAttachmentA, ctx)).toBe(false);
    });

    test("NOT visible from standard conversation even with same conversationId", () => {
      // Edge case: same conversationId but the context is not marked as private
      const ctx: AttachmentContext = {
        conversationId: privateAttachmentA.conversationId,
        isPrivate: false,
      };
      expect(isAttachmentVisible(privateAttachmentA, ctx)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// filterVisibleAttachments
// ---------------------------------------------------------------------------

describe("filterVisibleAttachments", () => {
  interface TestAttachment {
    id: string;
    conversationId: string;
    isPrivate: boolean;
  }

  const getContext = (a: TestAttachment): AttachmentContext => ({
    conversationId: a.conversationId,
    isPrivate: a.isPrivate,
  });

  const standardAtt: TestAttachment = {
    id: "att-1",
    conversationId: "conv-std",
    isPrivate: false,
  };
  const privateAttA: TestAttachment = {
    id: "att-2",
    conversationId: "conv-priv-a",
    isPrivate: true,
  };
  const privateAttB: TestAttachment = {
    id: "att-3",
    conversationId: "conv-priv-b",
    isPrivate: true,
  };

  const allAttachments = [standardAtt, privateAttA, privateAttB];

  test("returns all standard attachments regardless of context", () => {
    const ctx: AttachmentContext = {
      conversationId: "conv-unrelated",
      isPrivate: false,
    };
    const result = filterVisibleAttachments(allAttachments, ctx, getContext);
    expect(result).toEqual([standardAtt]);
  });

  test("includes matching private attachment when in same private conversation", () => {
    const ctx: AttachmentContext = {
      conversationId: "conv-priv-a",
      isPrivate: true,
    };
    const result = filterVisibleAttachments(allAttachments, ctx, getContext);
    expect(result).toEqual([standardAtt, privateAttA]);
  });

  test("includes only the private attachment for the current thread, not others", () => {
    const ctx: AttachmentContext = {
      conversationId: "conv-priv-b",
      isPrivate: true,
    };
    const result = filterVisibleAttachments(allAttachments, ctx, getContext);
    expect(result).toEqual([standardAtt, privateAttB]);
  });

  test("returns empty array when input is empty", () => {
    const ctx: AttachmentContext = {
      conversationId: "conv-std",
      isPrivate: false,
    };
    const result = filterVisibleAttachments([], ctx, getContext);
    expect(result).toEqual([]);
  });

  test("preserves original attachment objects (referential identity)", () => {
    const ctx: AttachmentContext = {
      conversationId: "conv-priv-a",
      isPrivate: true,
    };
    const result = filterVisibleAttachments(allAttachments, ctx, getContext);
    expect(result[0]).toBe(standardAtt);
    expect(result[1]).toBe(privateAttA);
  });
});
