// TODO: port from platform

export interface Assistant {
  id: string;
  status: string;
  is_local?: boolean;
  maintenance_mode?: { enabled: boolean };
  [key: string]: unknown;
}

export type HatchResult =
  | { ok: true; status: number; data: Assistant }
  | { ok: false; status: number; error: Record<string, unknown> };

export type GetAssistantResult =
  | { ok: true; status: number; data: Assistant }
  | { ok: false; status: number; error: Record<string, unknown> };

export async function getAssistant(_assistantId?: string): Promise<GetAssistantResult> {
  return { ok: false, status: 0, error: {} };
}
export async function hatchAssistant(_input?: { version?: string }): Promise<HatchResult> {
  return { ok: false, status: 0, error: {} };
}
export async function retireAssistantById(_id: string): Promise<{ ok: boolean; status: number; error?: Record<string, unknown> }> {
  return { ok: true, status: 200 };
}
export async function fetchAssistantIdentity() { return null; }
