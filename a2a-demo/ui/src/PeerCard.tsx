import type { PeerState } from './types.js';

function statusLabel(status: PeerState['status']): string {
  switch (status) {
    case 'idle':
      return 'Ready';
    case 'sent':
      return 'Sent...';
    case 'awaiting_human':
      return 'Waiting for human';
    case 'stale':
      return 'Stale - deadline approaching';
    case 'done':
      return 'Done';
  }
}

function statusClass(status: PeerState['status']): string {
  switch (status) {
    case 'idle':
      return 'status-idle';
    case 'sent':
      return 'status-sent';
    case 'awaiting_human':
      return 'status-awaiting';
    case 'stale':
      return 'status-stale';
    case 'done':
      return 'status-done';
  }
}

function basisBadgeClass(basis: string): string {
  switch (basis) {
    case 'standing_preference':
      return 'badge-standing';
    case 'confirmed':
      return 'badge-confirmed';
    case 'inferred':
      return 'badge-inferred';
    case 'unreachable':
      return 'badge-unreachable';
    default:
      return '';
  }
}

function basisLabel(basis: string): string {
  switch (basis) {
    case 'standing_preference':
      return 'Standing';
    case 'confirmed':
      return 'Confirmed';
    case 'inferred':
      return 'Inferred';
    case 'unreachable':
      return 'Unreachable';
    default:
      return basis;
  }
}

export function PeerCard({ id, name, relationship, status, responseText, responseBasis }: PeerState) {
  return (
    <div class={`peer-card ${statusClass(status)}`} data-peer-id={id}>
      <div class="peer-header">
        <h3 class="peer-name">{name}</h3>
        <span class="peer-relationship">{relationship}</span>
      </div>
      <div class={`peer-status ${statusClass(status)}`}>
        {statusLabel(status)}
      </div>
      {status === 'done' && responseText && (
        <div class="peer-response">
          <p class="response-text">{responseText}</p>
          {responseBasis && (
            <span class={`badge ${basisBadgeClass(responseBasis)}`}>
              {basisLabel(responseBasis)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
