import type { ClaimInput } from '@shale/sdk';

export interface ExtractedEntity {key:string;name:string;type:string;aliases?:string[]}
export interface ExtractedClaim extends Omit<ClaimInput,'id'|'subject'|'object'|'evidence'|'dependsOn'|'status'|'method'|'namespace'> {
  subject:string;object?:string;evidence:Array<{chunkIndex:number;quote:string}>;
}
export interface ExtractedEvent {
  key:string;name:string;kind:string;context?:string;occurredFrom?:number;occurredTo?:number;
  participants:Array<{entity:string;role:string;position?:number}>;
  evidence:Array<{chunkIndex:number;quote:string}>;
}
export interface Extraction {entities:ExtractedEntity[];claims:ExtractedClaim[];events:ExtractedEvent[]}
export interface ExtractionCursor { chunkIndex: number; offset: number; codePointOffset?: number }
export interface ExtractionChunk { chunk_index: number; text_content: string; start?: number }
export interface ExtractionCheckpoint {
  type:'knowledge-extraction';revisionId:number;sourceId:string;namespace:string;model?:string;
  extraction:Extraction;chunks:ExtractionChunk[];
  nextCursor?: ExtractionCursor | null;
}
