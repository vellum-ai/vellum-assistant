import { describe, expect, test } from "bun:test";

import {
  decideEmbeddingReconcile,
  type ReconcileAction,
} from "../reconcile-decision.js";

describe("decideEmbeddingReconcile", () => {
  test("fresh install, backend up -> commit-fresh", () => {
    const action = decideEmbeddingReconcile({
      committedDim: null,
      probeDim: 3072,
      configuredProvider: "gemini",
    });
    expect(action).toEqual({ kind: "commit-fresh", dim: 3072 });
  });

  test("fresh install, backend down -> defer-degraded", () => {
    const action = decideEmbeddingReconcile({
      committedDim: null,
      probeDim: null,
      configuredProvider: "auto",
    });
    expect(action).toEqual({
      kind: "defer-degraded",
      reason: "no reachable embedding backend",
    });
  });

  test("committed matches probe -> noop", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 384,
      probeDim: 384,
      configuredProvider: "auto",
    });
    expect(action).toEqual({ kind: "noop" });
  });

  test("explicit provider, mismatch upward -> migrate", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 384,
      probeDim: 3072,
      configuredProvider: "gemini",
    });
    expect(action).toEqual({ kind: "migrate", fromDim: 384, toDim: 3072 });
  });

  test("explicit provider, mismatch downward -> migrate", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 3072,
      probeDim: 384,
      configuredProvider: "local",
    });
    expect(action).toEqual({ kind: "migrate", fromDim: 3072, toDim: 384 });
  });

  test("auto provider, mismatch upward -> noop (no thrash)", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 384,
      probeDim: 3072,
      configuredProvider: "auto",
    });
    expect(action).toEqual({ kind: "noop" });
  });

  test("auto provider, mismatch downward -> noop (no thrash)", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 3072,
      probeDim: 384,
      configuredProvider: "auto",
    });
    expect(action).toEqual({ kind: "noop" });
  });

  test("existing collection, backend down -> defer-degraded", () => {
    const action = decideEmbeddingReconcile({
      committedDim: 3072,
      probeDim: null,
      configuredProvider: "gemini",
    });
    expect(action).toEqual({
      kind: "defer-degraded",
      reason: "no reachable embedding backend",
    });
  });

  test("defer-degraded precedes fresh-commit when both committed and probe are null", () => {
    const action: ReconcileAction = decideEmbeddingReconcile({
      committedDim: null,
      probeDim: null,
      configuredProvider: "gemini",
    });
    expect(action.kind).toBe("defer-degraded");
  });
});
