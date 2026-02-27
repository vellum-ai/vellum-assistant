import {
  appendTranscriptSegment,
  startLiveTranscript,
  stopLiveTranscript,
} from '../live-transcript-store.js';
import { defineHandlers, log } from './shared.js';

export const liveTranscriptHandlers = defineHandlers({
  live_transcript_start: () => {
    startLiveTranscript();
  },

  live_transcript_stop: () => {
    stopLiveTranscript();
  },

  live_transcript_update: (msg) => {
    if (msg.isFinal) {
      appendTranscriptSegment(msg.text, msg.timestamp);
    } else {
      log.debug('Ignoring non-final transcript update');
    }
  },
});
