#!/usr/bin/env bun

import { buildCliProgramAsync } from "./cli/program.js";

(await buildCliProgramAsync()).parse();
