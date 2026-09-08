import { beforeEach, expect, test } from "bun:test";

import {
  beginAssistantRequest,
  hasAssistantRespondedSince,
  recordAssistantRequestSuccess,
  recordAssistantStatusObservation,
  resetAssistantRequestActivity,
  useAssistantRequestActivity,
} from "./request-activity";

beforeEach(() => resetAssistantRequestActivity("a"));

test("a newer successful request supersedes an older status check", () => {
  const status = beginAssistantRequest("a");
  recordAssistantStatusObservation(status);
  recordAssistantRequestSuccess(beginAssistantRequest("a"));
  expect(hasAssistantRespondedSince(status)).toBe(true);
});

test("a delayed success cannot supersede a newer status check", () => {
  const request = beginAssistantRequest("a");
  const status = beginAssistantRequest("a");
  recordAssistantStatusObservation(status);
  recordAssistantRequestSuccess(request);
  expect(hasAssistantRespondedSince(status)).toBe(false);
});

test("an older status response cannot erase a newer success", () => {
  const status = beginAssistantRequest("a");
  recordAssistantRequestSuccess(beginAssistantRequest("a"));
  recordAssistantStatusObservation(status);
  expect(hasAssistantRespondedSince(status)).toBe(true);
});

test("out-of-order completions cannot roll either observation backward", () => {
  const oldStatus = beginAssistantRequest("a");
  const oldRequest = beginAssistantRequest("a");
  const newStatus = beginAssistantRequest("a");
  const newRequest = beginAssistantRequest("a");
  recordAssistantRequestSuccess(newRequest);
  recordAssistantStatusObservation(newStatus);
  recordAssistantRequestSuccess(oldRequest);
  recordAssistantStatusObservation(oldStatus);
  expect(hasAssistantRespondedSince(newStatus)).toBe(true);
});

test("switching away and back rejects responses from the previous session", () => {
  const request = beginAssistantRequest("a");
  resetAssistantRequestActivity("b");
  expect(beginAssistantRequest("a")).toBeNull();
  resetAssistantRequestActivity("a");
  recordAssistantRequestSuccess(request);
  expect(useAssistantRequestActivity.getState().lastSuccess).toBe(0);
});

test("logout clears evidence and rejects pending requests", () => {
  const request = beginAssistantRequest("a");
  recordAssistantRequestSuccess(request);
  resetAssistantRequestActivity(null);
  recordAssistantRequestSuccess(request);
  expect(useAssistantRequestActivity.getState().lastSuccess).toBe(0);
  expect(beginAssistantRequest("a")).toBeNull();
});
