import { getCharacterComponents } from "../../avatar/character-components.js";
import type { RouteDefinition } from "../http-router.js";

export function avatarRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "avatar/character-components",
      method: "GET",
      handler: () => Response.json(getCharacterComponents()),
    },
  ];
}
