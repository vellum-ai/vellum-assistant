#!/usr/bin/env bun

import { buildCliProgram } from "./cli/program.js";

(await buildCliProgram()).parse();
