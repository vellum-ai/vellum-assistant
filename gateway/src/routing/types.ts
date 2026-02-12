export type RouteResult = {
  assistantId: string;
  routeSource: "chat_id" | "user_id" | "default";
};

export type RouteRejection = {
  rejected: true;
  reason: string;
};

export type RoutingOutcome = RouteResult | RouteRejection;
