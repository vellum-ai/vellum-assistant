export interface DefaultRuleTemplate {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny';
}

/** Default trust rules shipped with the assistant. Backfilled at priority 0. */
export const DEFAULT_RULE_TEMPLATES: DefaultRuleTemplate[] = [];
