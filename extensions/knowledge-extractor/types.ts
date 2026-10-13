import type { ClaimInput } from '@shale/sdk';

export interface ExtractedEntity {
  key:string;name:string;type:string;aliases?:string[];
  /** One line saying what this is, for later identity decisions. */
  description?:string;
  /** Expansions, acronyms, and alternative spellings a search should also find it by. */
  searchKeys?:string[];
  /** Links or addresses in the source that identify the entity. */
  urls?:string[];
  /** The id of a listed registry entity this is the same thing as. */
  match?:number|null;
}
export type Involvement = 'none'|'observer'|'participant'|'author';
export interface DigestActivity {label:string;kind:string;stage?:string;episode?:number|'new'|null;confidence?:number}
export interface ExtractedClaim extends Omit<ClaimInput,'id'|'subject'|'object'|'evidence'|'dependsOn'|'status'|'method'|'namespace'> {
  subject:string;object?:string;evidence:Array<{chunkIndex:number;quote:string}>;
}
export interface ExtractedEvent {
  key:string;name:string;kind:string;context?:string;occurredFrom?:number;occurredTo?:number;
  participants:Array<{entity:string;role:string;position?:number}>;
  evidence:Array<{chunkIndex:number;quote:string}>;
}
export interface Extraction {
  entities:ExtractedEntity[];claims:ExtractedClaim[];events:ExtractedEvent[];
  /** Digest fields: present on a source's first window. */
  summary?:string;involvement?:Involvement;activity?:DigestActivity|null;
}
/** What the model was shown besides the text: used to validate its references. */
export interface DigestContext {
  header:string[];
  registry:Array<{id:number;name:string;type:string;description:string}>;
  episodes:Array<{id:number;title:string;lastStep:string}>;
  sourceUri:string;
  /** Participants are known and the user is not one of them. */
  userAbsent?:boolean;
}
export interface ExtractionCursor { chunkIndex: number; offset: number; codePointOffset?: number }
export interface ExtractionChunk { chunk_index: number; text_content: string; start?: number }
export interface ExtractionCheckpoint {
  type:'knowledge-extraction';revisionId:number;sourceId:string;namespace:string;model?:string;
  extraction:Extraction;chunks:ExtractionChunk[];
  nextCursor?: ExtractionCursor | null;
  /** First window of a revision: carries the digest fields. */
  first?: boolean;
  digest?: DigestContext;
}
