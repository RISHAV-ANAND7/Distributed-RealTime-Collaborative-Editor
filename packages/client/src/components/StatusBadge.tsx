import type { ConnectionStatus } from '../hooks/useWebSocket';

const CONFIG: Record<ConnectionStatus, { label: string; pulse: boolean }> = {
  connecting:   { label: 'Connecting',   pulse: false },
  open:         { label: 'Live',         pulse: true  },
  reconnecting: { label: 'Reconnecting', pulse: false },
  closed:       { label: 'Offline',      pulse: false },
};

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, pulse } = CONFIG[status];
  return (
    <span className={`status-badge status-${status}`} role="status" aria-label={`Connection: ${label}`}>
      <span className={`status-dot ${pulse ? 'status-dot-pulse' : ''}`} />
      {label}
    </span>
  );
}
