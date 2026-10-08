export type ClaimStatus = 'proposed' | 'accepted' | 'disputed' | 'rejected' | 'superseded' | 'retracted' | 'stale';
export type GraphValue = string | number | boolean | null | GraphValue[] | { [key: string]: GraphValue };
export interface GraphEntity {
  id: number; stableId: string; namespace: string; name: string; type: string; canonicalId: number | null; version?: number;
}
export interface EntityInput {
  stableId?: string; name: string; type: string; namespace?: string;
  aliases?: Array<string | { name: string; scope?: string }>;
  externalIds?: Record<string, string>;
}
export interface RelationDefinition {
  name: string; description?: string; sourceTypes?: string[]; targetTypes?: string[];
  symmetric?: boolean; inverse?: string; transitive?: boolean; maxTargets?: number;
}
export interface ClaimInput {
  id?: string; namespace?: string; subject: number; predicate: string;
  object?: number; value?: GraphValue; datatype?: string; unit?: string; language?: string;
  polarity?: 1 | -1; context?: string; qualifiers?: Record<string, GraphValue>;
  validFrom?: number; validTo?: number; observedAt?: number; confidence?: number; strength?: number;
  method?: string; model?: string; extractionRun?: string; status?: ClaimStatus; dependsOn?: string[];
  evidence?: EvidenceInput[];
}
export interface Claim extends Omit<ClaimInput, 'id' | 'evidence' | 'dependsOn' | 'namespace' | 'status'> {
  id: string; namespace: string; status: ClaimStatus; recordedAt: number; version?: number;
}
export interface EvidenceInput {
  id?: string; sourceId?: string; revisionId?: number; chunkIndex?: number;
  stance?: 'supports' | 'contradicts' | 'mentions'; quote?: string;
  locator?: { start?: number; end?: number; timestampMs?: number; page?: number; region?: number[] };
  method?: string; model?: string; confidence?: number;
}
export interface Evidence extends EvidenceInput {
  id: string; claimId: string; revisionId: number; sourceId: string; sourceHash: string;
  uri: string; title: string; createdAt: number; stale: boolean; withdrawnAt?: number; replacementId?: string;
}
export interface ClaimFilter {
  entityId?: number; subject?: number; object?: number; predicate?: string; namespace?: string; context?: string;
  statuses?: ClaimStatus[]; at?: number; knownAt?: number; limit?: number; offset?: number;
  polarity?: 1 | -1; predicates?: string[];
  objectOnly?: boolean;
}
export interface TraversalOptions extends ClaimFilter {
  start: number; direction?: 'out' | 'in' | 'both'; maxDepth?: number; maxNodes?: number; maxClaims?: number;
  predicates?: string[];
}
export interface GraphPath { entityId: number; depth: number; entityIds: number[]; claimIds: string[] }
export interface GraphTraversal { entities: GraphEntity[]; claims: Claim[]; paths: GraphPath[]; truncated: boolean }
export interface EventInput {
  stableId?: string; name: string; kind: string; namespace?: string; context?: string;
  occurredFrom?: number; occurredTo?: number;
  participants: Array<{ entity: number; role: string; position?: number; evidence?: EvidenceInput[] }>;
  evidence?: EvidenceInput[]; status?: ClaimStatus;
  method?: string; model?: string; extractionRun?: string;
}
export interface EventRecord {
  entity: GraphEntity; version?: number; claimId:string; kind: string; context: string; occurredFrom: number | null; occurredTo: number | null;
  participants: Array<{ entity: number; role: string; position: number; claimId: string }>;
}
