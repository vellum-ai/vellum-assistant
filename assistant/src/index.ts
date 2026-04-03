#!/usr/bin/env bun

import { buildCliProgram } from "./cli/program.js";
import { applyAssistantBunConfig } from "./util/bun-runtime.js";

applyAssistantBunConfig();

buildCliProgram().parse();
