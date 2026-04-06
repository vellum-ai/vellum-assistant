#!/usr/bin/env bun

import { buildCliProgram } from "./cli/program.js";
import { initFeatureFlagOverrides } from "./config/assistant-feature-flags.js";

await initFeatureFlagOverrides();
buildCliProgram().parse();
