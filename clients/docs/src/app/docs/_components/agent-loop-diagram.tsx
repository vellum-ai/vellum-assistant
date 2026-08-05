import {
  DiagramArrowMarkers,
  DiagramLegend,
  DiagramNode,
  controlEdge,
  controlLabel,
  hookEdge,
  hookLabel,
  junctionDot,
  labelBg,
} from "@/app/docs/_components/extensibility-diagram-primitives";

/**
 * The Agent Loop: the per-turn path a request travels through, with the hooks
 * that fire on each transition drawn as edges. Session-level init/shutdown are
 * not part of the loop and live in the AssistantLifecycleDiagram instead.
 */
export function AgentLoopDiagram() {
  return (
    <figure className="my-6">
      <svg
        viewBox="0 0 760 640"
        width="100%"
        role="img"
        aria-labelledby="agent-loop-title agent-loop-desc"
        style={{
          maxWidth: 700,
          height: "auto",
          display: "block",
          margin: "0 auto",
        }}
      >
        <title id="agent-loop-title">The Agent Loop</title>
        <desc id="agent-loop-desc">
          A turn flows from the user prompt through a context check, model call,
          and model response to the assistant reply, with tool results and a
          compaction branch looping back. When the context check finds the
          conversation does not fit within the context window, control branches
          to compaction; a context error on the model response also branches to
          compaction. The hooks user-prompt-submit, pre-model-call, post-compact,
          post-model-call, post-tool-use, and stop fire on the transitions.
        </desc>

        <DiagramArrowMarkers prefix="agent-loop" />

        {/* user-prompt-submit: User prompt -> merge junction */}
        <path d="M250 77 L250 132" style={hookEdge} />
        <rect x={110} y={95} width={126} height={18} style={labelBg} />
        <text x={236} y={108} textAnchor="end" style={hookLabel}>
          user-prompt-submit
        </text>

        {/* post-tool-use: Tool result -> merge junction, routed as a squared
            loop up the right and across the top (rounded corner). */}
        <path
          d="M600 418 L600 144 Q600 132 588 132 L258 132"
          style={hookEdge}
          markerEnd="url(#agent-loop-arrow-hook)"
        />
        <rect x={378} y={124} width={104} height={18} style={labelBg} />
        <text x={430} y={137} textAnchor="middle" style={hookLabel}>
          post-tool-use
        </text>

        {/* merge junction: where user-prompt-submit, post-tool-use, and continue meet */}
        <circle cx={250} cy={132} r={3.5} style={junctionDot} />

        {/* control flow: merge junction -> Context check */}
        <path
          d="M250 132 L250 188"
          style={controlEdge}
          markerEnd="url(#agent-loop-arrow-control)"
        />

        {/* Context check -> Compaction branch (squared, rounded corner) */}
        <path
          d="M344 215 L458 215 Q470 215 470 227 L470 245"
          style={controlEdge}
          markerEnd="url(#agent-loop-arrow-control)"
        />
        <rect x={347} y={192} width={108} height={18} style={labelBg} />
        <text x={401} y={205} textAnchor="middle" style={controlLabel}>
          context too large
        </text>

        {/* pre-model-call: Context check -> Model call */}
        <path
          d="M250 242 L250 303"
          style={hookEdge}
          markerEnd="url(#agent-loop-arrow-hook)"
        />
        <rect x={138} y={260} width={98} height={18} style={labelBg} />
        <text x={236} y={273} textAnchor="end" style={hookLabel}>
          pre-model-call
        </text>

        {/* post-compact: Compaction -> back onto the pre-model-call arrow */}
        <path
          d="M376 272 L258 272"
          style={hookEdge}
          markerEnd="url(#agent-loop-arrow-hook)"
        />
        <rect x={273} y={253} width={88} height={18} style={labelBg} />
        <text x={317} y={266} textAnchor="middle" style={hookLabel}>
          post-compact
        </text>

        {/* post-model-call: Model call -> Model response */}
        <path
          d="M250 357 L250 418"
          style={hookEdge}
          markerEnd="url(#agent-loop-arrow-hook)"
        />
        <rect x={132} y={375} width={104} height={18} style={labelBg} />
        <text x={236} y={388} textAnchor="end" style={hookLabel}>
          post-model-call
        </text>

        {/* Context Error: Model response -> Compaction (squared, rounded
            corner). Drawn as the upper branch so its riser to Compaction does
            not cross the tool_use arrow below it. */}
        <path
          d="M344 445 L458 445 Q470 445 470 433 L470 299"
          style={controlEdge}
          markerEnd="url(#agent-loop-arrow-control)"
        />
        <rect x={365} y={381} width={86} height={18} style={labelBg} />
        <text x={408} y={394} textAnchor="middle" style={controlLabel}>
          Context Error
        </text>

        {/* tool_use branch: Model response -> Tool result, routed below the
            Context Error branch so the two do not criss-cross. */}
        <path
          d="M344 458 L506 458"
          style={controlEdge}
          markerEnd="url(#agent-loop-arrow-control)"
        />
        <text x={425} y={473} textAnchor="middle" style={controlLabel}>
          tool_use
        </text>

        {/* stop: Model response -> Assistant reply */}
        <path
          d="M250 472 L250 548"
          style={hookEdge}
          markerEnd="url(#agent-loop-arrow-hook)"
        />
        <text x={264} y={514} style={hookLabel}>
          stop
        </text>

        {/* continue: post-model-call decision branch from the model response,
            squared up the left and back to the junction (rounded corners). */}
        <path
          d="M156 445 L124 445 Q112 445 112 433 L112 144 Q112 132 124 132 L246 132"
          style={controlEdge}
          markerEnd="url(#agent-loop-arrow-control)"
        />
        <rect x={54} y={316} width={52} height={18} style={labelBg} />
        <text x={104} y={329} textAnchor="end" style={controlLabel}>
          continue
        </text>

        {/* Nodes */}
        <DiagramNode cx={250} cy={50} label="User prompt" />
        <DiagramNode cx={250} cy={215} label="Context check" />
        <DiagramNode cx={250} cy={330} label="Model call" />
        <DiagramNode cx={250} cy={445} label="Model response" />
        <DiagramNode cx={250} cy={575} label="Assistant reply" />
        <DiagramNode cx={470} cy={272} label="Compaction" />
        <DiagramNode cx={600} cy={445} label="Tool result" />
      </svg>

      <DiagramLegend />
    </figure>
  );
}
