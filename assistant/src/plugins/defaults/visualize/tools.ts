/**
 * The `default-visualize` plugin's model-visible tools, in the order the
 * model should use them: load the design system, then render.
 */

import { type Tool } from "@vellumai/plugin-api";

import { visualizeGuideTool } from "./src/visualize-guide-tool.js";
import { visualizeRenderTool } from "./src/visualize-render-tool.js";

export const visualizeTools: Tool[] = [visualizeGuideTool, visualizeRenderTool];

export { visualizeGuideTool, visualizeRenderTool };
