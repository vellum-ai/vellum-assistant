import type { CdpClient } from "./types.js";

// Runs in an isolated world on the resolved node, never with model-supplied code.
const CHECK_ELEMENT = `function(editable) {
  if (!this.isConnected || this.ownerDocument !== document) { return null; }
  const style = getComputedStyle(this);
  const r = this.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || style.visibility !== 'visible' || style.display === 'none' ||
      this.matches(':disabled') || this.closest('[inert], [aria-disabled="true"]')) { return null; }
  if (editable && (this.readOnly || !(this.isContentEditable || this instanceof HTMLTextAreaElement ||
      (this instanceof HTMLInputElement && ['text','search','url','tel','email','password','number'].includes(this.type))))) { return null; }
  const x = (Math.max(0, r.left) + Math.min(innerWidth, r.right)) / 2;
  const y = (Math.max(0, r.top) + Math.min(innerHeight, r.bottom)) / 2;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) { return null; }
  let element = this;
  while (element) {
    if (element.closest('[inert], [aria-disabled="true"]')) { return null; }
    const root = element.getRootNode();
    const hit = root.elementFromPoint(x, y);
    if (!hit || !(hit === element || element.contains(hit))) { return null; }
    element = root.host;
  }
  return { x, y, width: r.width, height: r.height };
}`;

export async function actionableElement(
  cdp: CdpClient,
  objectId: string,
  editable: boolean,
  signal: AbortSignal,
): Promise<{ x: number; y: number }> {
  const check = async () => {
    const response = await cdp.send<{
      result: {
        value?: { x: number; y: number; width: number; height: number };
      };
      exceptionDetails?: unknown;
    }>(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: CHECK_ELEMENT,
        arguments: [{ value: editable }],
        returnByValue: true,
      },
      signal,
    );
    if (response.exceptionDetails || !response.result.value) {
      throw new Error(
        "Element is detached, hidden, disabled, covered or not editable. Observe again.",
      );
    }
    return response.result.value;
  };
  const before = await check();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  signal.throwIfAborted();
  const after = await check();
  if (
    Object.keys(before).some(
      (key) =>
        Math.abs(
          before[key as keyof typeof before] - after[key as keyof typeof after],
        ) > 1,
    )
  ) {
    throw new Error("Element is moving. Observe again when stable.");
  }
  return after;
}
