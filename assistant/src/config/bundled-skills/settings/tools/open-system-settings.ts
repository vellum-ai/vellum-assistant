import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

const PANES = {
  microphone: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    label: "Microphone privacy",
    instruction: "Please toggle Vellum Assistant on.",
  },
  speech_recognition: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
    label: "Speech Recognition privacy",
    instruction: "Please toggle Vellum Assistant on.",
  },
} as const;

type PaneName = keyof typeof PANES;

const VALID_PANES = Object.keys(PANES) as PaneName[];

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const pane = input.pane as string;
  if (!VALID_PANES.includes(pane as PaneName)) {
    return {
      content: `Error: unknown pane "${pane}". Valid panes: ${VALID_PANES.join(
        ", ",
      )}`,
      isError: true,
    };
  }

  const meta = PANES[pane as PaneName];

  // Send open_url to the client - the x-apple.systempreferences: scheme
  // opens System Settings directly without a browser confirmation dialog.
  if (context.sendToClient) {
    context.sendToClient({
      type: "open_url",
      url: meta.url,
    });
  }

  return {
    content: `Opened System Settings to ${meta.label}. ${meta.instruction}`,
    isError: false,
  };
}
