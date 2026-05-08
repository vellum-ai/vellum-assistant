import { useEffect, useState } from 'react';

import type { AssistantAuthProfile } from '../../background/assistant-auth-profile.js';
import type {
  ConnectionHealthDetail,
  ConnectionHealthState,
  GetStatusResponse,
} from '../popup-state.js';
import { sendMessage } from '../lib/chrome-message.js';

const STATUS_POLL_INTERVAL_MS = 2_000;

interface StatusPollState {
  health: ConnectionHealthState;
  healthDetail: ConnectionHealthDetail;
  authProfile: AssistantAuthProfile | null;
}

export function useStatusPoll(enabled: boolean): StatusPollState {
  const [state, setState] = useState<StatusPollState>({
    health: 'paused',
    healthDetail: { lastChangeAt: 0 },
    authProfile: null,
  });

  useEffect(() => {
    if (!enabled) return;

    function poll() {
      sendMessage<GetStatusResponse>({ type: 'get_status' }).then((response) => {
        if (!response) return;
        setState((prev) => {
          if (
            prev.health === response.health &&
            prev.authProfile === response.authProfile &&
            prev.healthDetail.lastChangeAt === response.healthDetail.lastChangeAt
          ) {
            return prev;
          }
          return {
            health: response.health,
            healthDetail: response.healthDetail,
            authProfile: response.authProfile,
          };
        });
      });
    }

    poll();
    const timer = setInterval(poll, STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  return state;
}
