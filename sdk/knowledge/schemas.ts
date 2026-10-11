import { z } from 'zod';

const text = z.string().trim().min(1).max(1000);
const id = z.number().int().positive();
const key = z.string().min(1).max(1000);
export const entityReference = z.union([id, key]);
export const claimStatus = z.enum(['proposed','accepted','disputed','rejected','superseded','retracted','stale']);
const json = z.json();
const metadata = z.record(z.string(),json);
const time = z.number().int().safe();
const score = z.number().min(0).max(1);
const version = z.number().int().positive().optional();
const page = {limit:z.number().int().min(1).max(200).default(50),offset:z.number().int().min(0).default(0)};
export const evidenceInput = z.object({
  id:key.optional(),sourceId:key.optional(),revisionId:id.optional(),chunkIndex:z.number().int().min(0).optional(),
  stance:z.enum(['supports','contradicts','mentions']).optional(),quote:z.string().max(100000).optional(),
  locator:z.object({start:z.number().int().min(0).optional(),end:z.number().int().min(0).optional(),
    timestampMs:z.number().int().min(0).optional(),page:z.number().int().min(0).optional(),region:z.array(z.number()).length(4).optional()}).optional(),
  method:text.optional(),model:text.optional(),confidence:score.optional(),
}).strict();
export const entityInput = z.object({name:text,type:text.default('Entity'),namespace:text.optional(),stableId:key.optional(),
  aliases:z.array(z.union([text,z.object({name:text,scope:z.string().max(1000).optional()})])).max(100).optional(),
  externalIds:z.record(z.string(),text).optional()}).strict();
export const claimInput = z.object({id:key.optional(),namespace:text.optional(),subject:entityReference,predicate:text,
  object:entityReference.optional(),value:json.optional(),datatype:text.optional(),unit:text.optional(),language:text.optional(),
  polarity:z.union([z.literal(1),z.literal(-1)]).optional(),context:z.string().max(1000).optional(),qualifiers:metadata.optional(),
  validFrom:time.optional(),validTo:time.optional(),observedAt:time.optional(),confidence:score.optional(),strength:z.number().finite().optional(),
  method:text.optional(),model:text.optional(),extractionRun:text.optional(),status:claimStatus.optional(),
  dependsOn:z.array(key).max(100).optional(),evidence:z.array(evidenceInput).max(100).optional()}).strict();
const patch = claimInput.partial().extend({object:entityReference.nullable().optional(),
  datatype:text.nullable().optional(),unit:text.nullable().optional(),language:text.nullable().optional(),
  validFrom:time.nullable().optional(),validTo:time.nullable().optional(),confidence:score.nullable().optional()}).omit({id:true});
const participants = z.array(z.object({entity:entityReference,role:text,position:z.number().int().min(0).optional(),
  evidence:z.array(evidenceInput).max(100).optional()}).strict()).max(100);
export const mutationSchemas = {
  update_entity:z.object({id,expectedVersion:version,name:text.optional(),type:text.optional()}).strict(),
  remove_entity_alias:z.object({id,expectedVersion:version,name:text,scope:z.string().default('')}).strict(),
  split_entity:z.object({id,expectedVersion:version,entities:z.array(entityInput.extend({ref:key,
    aliasesToMove:z.array(z.object({name:text,scope:z.string().default('')})).max(100).default([]),
    claimIds:z.array(key).max(200).default([]),chunkIds:z.array(id).max(200).default([])})).min(1).max(20)}).strict(),
  connect_entities:claimInput,
  revise_connection:z.object({claimId:key,expectedVersion:version,patch}).strict(),
  retract_connection:z.object({claimId:key,expectedVersion:version}).strict(),
  revise_claim:z.object({claimId:key,expectedVersion:version,patch}).strict(),
  unlink_claims:z.object({from:key,to:key,relation:z.enum(['supports','contradicts','supersedes']),expectedVersion:version}).strict(),
  add_claim_dependency:z.object({claimId:key,dependsOn:key,expectedVersion:version}).strict(),
  remove_claim_dependency:z.object({claimId:key,dependsOn:key,expectedVersion:version}).strict(),
  batch_review_claims:z.object({claims:z.array(z.object({claimId:key,status:claimStatus,expectedVersion:version})).min(1).max(200)}).strict(),
  revise_evidence:z.object({evidenceId:key,expectedVersion:version,patch:evidenceInput.omit({id:true}).partial().extend({
    sourceId:key.nullable().optional(),revisionId:id.nullable().optional(),chunkIndex:z.number().int().min(0).nullable().optional(),
    quote:z.string().max(100000).nullable().optional(),locator:evidenceInput.shape.locator.unwrap().nullable().optional(),
    confidence:score.nullable().optional(),model:text.nullable().optional(),
  })}).strict(),
  retract_evidence:z.object({evidenceId:key,expectedVersion:version}).strict(),
  revise_event:z.object({id,expectedVersion:version,name:text.optional(),kind:text.optional(),context:z.string().max(1000).optional(),
    occurredFrom:time.nullable().optional(),occurredTo:time.nullable().optional(),participants:participants.optional()}).strict(),
  append_graph:z.object({entities:z.array(entityInput.extend({ref:key})).max(200).default([]),claims:z.array(claimInput).max(200).default([])}).strict(),
  add_source:z.object({id:key.optional(),title:text,uri:text,type:text.default('text'),origin:text.default('mcp-agent'),
    namespace:text.optional(),metadata:metadata.default({}),text:z.string().trim().min(1).max(1000000),chunkSize:z.number().int().min(100).max(20000).default(2000)}).strict(),
  update_source:z.object({sourceId:key,expectedVersion:version,title:text.optional(),uri:text.optional(),metadata:metadata.optional()}).strict(),
  remove_source:z.object({sourceId:key,expectedVersion:version,blockReingestion:z.boolean().default(false)}).strict(),
  restore_source:z.object({sourceId:key,expectedVersion:version,unblockReingestion:z.boolean().default(false)}).strict(),
  add_chunk:z.object({sourceId:key,expectedVersion:version,text:z.string().trim().min(1).max(1200),
    chunkType:z.enum(['verbatim','synthetic']).default('synthetic'),entityIds:z.array(id).max(100).default([]),claimIds:z.array(key).max(100).default([])}).strict(),
  revise_chunk:z.object({sourceId:key,chunkId:id,expectedVersion:version,expectedSourceVersion:version,
    text:z.string().trim().min(1).max(8000).optional(),chunkType:z.enum(['verbatim','synthetic']).optional(),
    entityIds:z.array(id).max(100).optional(),claimIds:z.array(key).max(100).optional()}).strict(),
  remove_chunk:z.object({sourceId:key,chunkId:id,expectedVersion:version,expectedSourceVersion:version}).strict(),
};
export type MutationName = keyof typeof mutationSchemas;
export type MutationArgs<N extends MutationName> = z.input<(typeof mutationSchemas)[N]>;
export const operationSchema = z.discriminatedUnion('type',Object.entries(mutationSchemas).map(([name,schema]) =>
  z.object({type:z.literal(name),args:schema}).strict()) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
export const changeInput = z.object({actor:text.default('mcp-agent'),reason:text,requestId:key.optional(),
  operations:z.array(operationSchema).min(1).max(200)}).strict();
export const readSchemas = {
  list_entities:z.object({...page,name:z.string().max(1000).optional(),type:text.optional(),namespace:text.optional()}),
  list_connections:z.object({...page,entity:entityReference,direction:z.enum(['in','out','both']).default('both'),
    predicates:z.array(text).max(100).optional(),statuses:z.array(claimStatus).optional(),context:z.string().optional()}),
  get_source_revision:z.object({revisionId:id}),
  find_connection_candidates:z.object({entity:entityReference,limit:z.number().int().min(1).max(100).default(20),
    namespace:text.optional()}),
  find_duplicate_entities:z.object({entity:entityReference.optional(),namespace:text.optional(),limit:z.number().int().min(1).max(100).default(20)}),
  list_sources:z.object({...page,title:z.string().max(1000).optional(),uri:z.string().max(1000).optional(),origin:text.optional(),type:text.optional(),namespace:text.optional(),
    status:z.enum(['live','removed','all']).default('live')}),
  inspect_source:z.object({sourceId:key}),
  list_chunks:z.object({...page,sourceId:key,archived:z.boolean().default(false)}),
};
export const mutationContext = {actor:text.default('mcp-agent'),reason:text,requestId:key.optional()};
