import { setBundledLiveVoiceSessionFactory } from "./live-voice-manager.js";
import { createLiveVoiceSession } from "./live-voice-session.js";

setBundledLiveVoiceSessionFactory(createLiveVoiceSession);
