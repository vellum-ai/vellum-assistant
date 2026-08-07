import pino from "pino";
import pinoPretty from "pino-pretty";

import { setBundledLoggerModules } from "./util/logger.js";

setBundledLoggerModules(pino, pinoPretty);
