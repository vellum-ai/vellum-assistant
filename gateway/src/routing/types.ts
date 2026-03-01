export type RouteResult = {
  assistantId: string;
  routeSource: "conversation_id" | "actor_id" | "default" | "phone_number";
};

export type RouteRejection = {
  rejected: true;
  reason: string;
};

export type RoutingOutcome = RouteResult | RouteRejection;
