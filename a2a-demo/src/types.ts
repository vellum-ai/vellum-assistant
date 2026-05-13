import type { AgentCard } from '@a2a-js/sdk';

export type RelationshipType = 'colleague' | 'work_contact' | 'friend' | 'family' | 'other';
export type ResponseBasis = 'confirmed' | 'standing_preference' | 'inferred' | 'unreachable';
export type HitlState = 'awaiting_human_input' | 'awaiting_human_input_stale';

// TypeScript typed wrapper — AgentCard may reject extra literal fields
export type VellumAgentCard = AgentCard & { 'x-vellum-social-v1': true };

export interface Connection {
  id: string;
  owner_assistant_id: string;
  peer_assistant_id: string;
  peer_agent_card_url: string;
  peer_base_url: string;
  declared_relationship: RelationshipType;
  scopes: string[];
  created_at: string;
}

export interface ConnectionsConfig {
  owner: { id: string; name: string; port: number };
  connections: Connection[];
}

export interface VellumSocialRequestData {
  extension: 'x-vellum-social-v1';
  connection_id: string;
  sender_relationship: RelationshipType;
  correlation_id: string;
  deadline?: string;
}

export interface VellumSocialResponseData {
  extension: 'x-vellum-social-v1';
  response_basis: ResponseBasis;
  correlation_id: string;
}

export interface VellumSocialWorkingData {
  extension: 'x-vellum-social-v1';
  hitl_state: HitlState;
  correlation_id: string;
}

export type VellumSocialData = VellumSocialRequestData | VellumSocialResponseData | VellumSocialWorkingData;
