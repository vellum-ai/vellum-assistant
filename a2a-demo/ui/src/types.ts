export type PeerStatus = 'idle' | 'sent' | 'awaiting_human' | 'stale' | 'done';

export interface PeerState {
  id: string;
  name: string;
  relationship: string;
  status: PeerStatus;
  responseText?: string;
  responseBasis?: string;
}

export interface LogEntry {
  timestamp: string;
  direction: 'out' | 'in';
  peer: string;
  message: string;
  raw?: object;
}

export type SSEEvent =
  | {
      type: 'task_sent';
      peer: string;
      messageId: string;
      correlationId: string;
      taskId: null;
      method: string;
    }
  | {
      type: 'hitl_update';
      peer: string;
      taskId: string;
      hitlState: string;
      sdkEvent: object;
    }
  | {
      type: 'task_completed';
      peer: string;
      taskId: string;
      responseText: string;
      responseBasis: string;
      sdkEvent: object;
    }
  | {
      type: 'task_error';
      peer: string;
      taskId: string | null;
      error: string;
    }
  | {
      type: 'protocol_event';
      peer: string;
      taskId: string;
      eventType: string;
      sdkEvent: object;
    }
  | {
      type: 'run_complete';
    };
