import {
  DiagramArrowMarkers,
  DiagramLegend,
  DiagramNode,
  controlEdge,
  controlLabel,
  hookEdge,
  hookLabel,
  labelBg,
} from "@/app/docs/_components/extensibility-diagram-primitives";

/**
 * The Assistant Lifecycle: the session-level bracket around the Agent Loop.
 * `init` fires once when the plugin wakes and `shutdown` once when the
 * Assistant sleeps it; while the Run Server is up it exchanges conversations
 * with the Agent Loop, which persists to the Workspace.
 */
export function AssistantLifecycleDiagram() {
  return (
    <figure className="my-6">
      <svg
        viewBox="0 0 640 460"
        width="100%"
        role="img"
        aria-labelledby="assistant-lifecycle-title assistant-lifecycle-desc"
        style={{
          maxWidth: 600,
          height: "auto",
          display: "block",
          margin: "0 auto",
        }}
      >
        <title id="assistant-lifecycle-title">The Assistant Lifecycle</title>
        <desc id="assistant-lifecycle-desc">
          A plugin wakes, runs while the Run Server is up, then sleeps. The init
          and shutdown hooks fire once each on those boundaries. The Run Server
          exchanges conversations with the Agent Loop, which persists to the
          Workspace.
        </desc>

        <DiagramArrowMarkers prefix="assistant-lifecycle" />

        {/* init: Wake -> Run Server */}
        <path
          d="M200 77 L200 188"
          style={hookEdge}
          markerEnd="url(#assistant-lifecycle-arrow-hook)"
        />
        <text x={214} y={137} style={hookLabel}>
          init
        </text>

        {/* shutdown: Run Server -> Sleep */}
        <path
          d="M200 242 L200 353"
          style={hookEdge}
          markerEnd="url(#assistant-lifecycle-arrow-hook)"
        />
        <text x={214} y={302} style={hookLabel}>
          shutdown
        </text>

        {/* Conversations: Run Server <-> Agent Loop (bidirectional) */}
        <path
          d="M294 215 L406 215"
          style={controlEdge}
          markerStart="url(#assistant-lifecycle-arrow-control)"
          markerEnd="url(#assistant-lifecycle-arrow-control)"
        />
        <rect x={302} y={197} width={96} height={18} style={labelBg} />
        <text x={350} y={211} textAnchor="middle" style={controlLabel}>
          Conversations
        </text>

        {/* persistence: Agent Loop <-> Workspace (bidirectional) */}
        <path
          d="M500 242 L500 353"
          style={controlEdge}
          markerStart="url(#assistant-lifecycle-arrow-control)"
          markerEnd="url(#assistant-lifecycle-arrow-control)"
        />
        <text x={514} y={302} style={controlLabel}>
          persistence
        </text>

        {/* Nodes */}
        <DiagramNode cx={200} cy={50} label="Wake" />
        <DiagramNode cx={200} cy={215} label="Run Server" />
        <DiagramNode cx={200} cy={380} label="Sleep" />
        <DiagramNode cx={500} cy={215} label="Agent Loop" />
        <DiagramNode cx={500} cy={380} label="Workspace" />
      </svg>

      <DiagramLegend showControl={false} />
    </figure>
  );
}
