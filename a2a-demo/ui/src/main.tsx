import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { PeerCard } from './PeerCard.js';
import { ProtocolLog } from './ProtocolLog.js';
import type { PeerState, LogEntry, SSEEvent } from './types.js';

interface ConnectionsResponse {
  owner: { id: string; name: string };
  connections: Array<{
    peer_assistant_id: string;
    declared_relationship: string;
  }>;
}

function now(): string {
  return new Date().toISOString();
}

function peerDisplayName(peerId: string): string {
  // "peer-sarah" -> "Sarah"
  const parts = peerId.split('-');
  const name = parts.length > 1 ? parts[parts.length - 1] : peerId;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function App() {
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [ownerName, setOwnerName] = useState('');
  const [connectionCount, setConnectionCount] = useState(0);

  useEffect(() => {
    // Fetch connections to populate peer list
    fetch('/connections')
      .then((res) => res.json() as Promise<ConnectionsResponse>)
      .then((data) => {
        setOwnerName(data.owner.name);
        setConnectionCount(data.connections.length);
        setPeers(
          data.connections.map((c) => ({
            id: c.peer_assistant_id,
            name: peerDisplayName(c.peer_assistant_id),
            relationship: c.declared_relationship,
            status: 'idle' as const,
          }))
        );
      })
      .catch((err) => {
        console.error('Failed to load connections:', err);
      });

    // Connect EventSource on page load (before any POST)
    const es = new EventSource('/events');

    es.onmessage = (e) => {
      let event: SSEEvent;
      try {
        event = JSON.parse(e.data) as SSEEvent;
      } catch {
        return;
      }

      switch (event.type) {
        case 'task_sent': {
          const name = peerDisplayName(event.peer);
          setPeers((prev) =>
            prev.map((p) => (p.id === event.peer ? { ...p, status: 'sent' as const } : p))
          );
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'out',
              peer: name,
              message: `${event.method} (correlation: ${event.correlationId})`,
            },
          ]);
          break;
        }

        case 'hitl_update': {
          const name = peerDisplayName(event.peer);
          const newStatus =
            event.hitlState === 'awaiting_human_input_stale'
              ? ('stale' as const)
              : ('awaiting_human' as const);
          setPeers((prev) =>
            prev.map((p) => (p.id === event.peer ? { ...p, status: newStatus } : p))
          );
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'in',
              peer: name,
              message: `HITL: ${event.hitlState}`,
              raw: event.sdkEvent,
            },
          ]);
          break;
        }

        case 'task_completed': {
          const name = peerDisplayName(event.peer);
          setPeers((prev) =>
            prev.map((p) =>
              p.id === event.peer
                ? {
                    ...p,
                    status: 'done' as const,
                    responseText: event.responseText,
                    responseBasis: event.responseBasis,
                  }
                : p
            )
          );
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'in',
              peer: name,
              message: `Completed: ${event.responseText} (${event.responseBasis})`,
              raw: event.sdkEvent,
            },
          ]);
          break;
        }

        case 'task_error': {
          const name = peerDisplayName(event.peer);
          setPeers((prev) =>
            prev.map((p) =>
              p.id === event.peer
                ? {
                    ...p,
                    status: 'done' as const,
                    responseText: `Error: ${event.error}`,
                    responseBasis: 'unreachable',
                  }
                : p
            )
          );
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'in',
              peer: name,
              message: `Error: ${event.error}`,
            },
          ]);
          break;
        }

        case 'protocol_event': {
          const name = peerDisplayName(event.peer);
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'in',
              peer: name,
              message: `${event.eventType}`,
              raw: event.sdkEvent,
            },
          ]);
          break;
        }

        case 'run_complete': {
          setRunning(false);
          setLog((prev) => [
            ...prev,
            {
              timestamp: now(),
              direction: 'in',
              peer: 'system',
              message: 'Run complete',
            },
          ]);
          break;
        }
      }
    };

    return () => {
      es.close();
    };
  }, []);

  function startCoffeeRun() {
    setRunning(true);
    // Reset peers to sent/idle
    setPeers((prev) => prev.map((p) => ({ ...p, status: 'idle' as const, responseText: undefined, responseBasis: undefined })));
    setLog([]);
    fetch('/run/coffee', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadlineSeconds: 15 }),
    }).catch((err) => {
      console.error('Failed to start coffee run:', err);
      setRunning(false);
    });
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>{ownerName || 'A2A Demo'}</h1>
        <span class="connection-count">{connectionCount} connections</span>
        <button class="start-button" onClick={startCoffeeRun} disabled={running}>
          {running ? 'Running...' : 'Start coffee run'}
        </button>
      </header>
      <section class="peer-grid">
        {peers.map((peer) => (
          <PeerCard key={peer.id} {...peer} />
        ))}
      </section>
      <section class="log-section">
        <h2>Protocol Log</h2>
        <ProtocolLog entries={log} />
      </section>
    </div>
  );
}

render(<App />, document.getElementById('app')!);
