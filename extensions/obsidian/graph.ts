import { resolve, basename } from 'node:path';
import { SourceGraph, type ShaleSDK, type GraphValue } from '@shale/sdk';
import { commitPreparedClaims } from '../../sdk/graph/prepared';
import type { ParsedFile } from './parse-file';
import type { ParsedImage } from './parse-image';
import { prepareSourceMemory } from '../../lib/memory/prepare';

export interface VaultContext { name: string; path: string }

function localUri(path: string) { return `file://${resolve(path)}`; }

export function linkVaultMembership(graph: SourceGraph, subject: number, vault: VaultContext) {
  const entity = graph.entity(localUri(vault.path),`Vault: ${vault.name}`,'Vault');
  graph.link(subject,'IN_VAULT',entity);
}

export function commitNoteGraph(sdk: ShaleSDK, sourceId: string, namespace: string,
  file: ParsedFile, vault: VaultContext): SourceGraph {
  file = file.memory ? file : { ...file, memory: prepareSourceMemory(file.contextualChunks, { title: file.noteTitle }) };
  const memory = file.memory!;
  const graph = new SourceGraph(sdk.database,sdk.graph,sourceId,namespace,file.updatedAt);
  const note = graph.entity(file.noteUri,file.noteTitle,'Note');
  // Older recovery records stored chunks without parsed markdown metadata.
  const parsed = file.parsed ?? {frontmatter:{},tags:[],wikilinks:[],images:[],references:[]};
  linkVaultMembership(graph,note,vault);
  graph.claim(note,'SOURCE_URI',{value:file.noteUri});
  graph.claim(note,'TITLE',{value:file.noteTitle});
  for (const [key,value] of Object.entries(parsed.frontmatter)) {
    graph.claim(note,`PROPERTY:${key}`,{value:JSON.parse(JSON.stringify(value)) as GraphValue},
      {method:'frontmatter',evidence:graph.quote(key + ':')});
  }
  const aliases = parsed.frontmatter.aliases;
  for (const alias of Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? [aliases] : [])
    if (typeof alias === 'string' && alias.trim()) sdk.graph.entities.addAlias(note,alias,localUri(vault.path));
  for (const tag of parsed.tags) {
    const entity = graph.entity(`tag:${tag}`,tag,'Tag');
    graph.link(note,'HAS_TAG',entity,{method:'markdown',evidence:graph.quote(tag)});
  }
  for (const reference of parsed.references ?? parsed.wikilinks.map(target=>({target,raw:target}))) {
    const {target} = reference;
    const path = file.linkTargets?.[target];
    const entity = path ? graph.entity(localUri(path),basename(path,'.md'),'Note')
      : graph.entity(`${file.noteUri}#reference:${target}`,target,'NoteReference');
    graph.link(note,'REFERENCES',entity,{method:'wikilink',evidence:graph.quote(reference.raw),
      qualifiers:{target,resolved:!!path,vault:localUri(vault.path),
        ...JSON.parse(JSON.stringify(reference))}});
  }
  for (const image of parsed.images) {
    const uri = file.assetTargets?.[image] ?? (/^https?:\/\//.test(image) ? image : undefined);
    const key = uri ?? `${file.noteUri}#asset-reference:${image}`;
    graph.link(note,'FEATURES_IMAGE',graph.entity(key,basename(image),uri ? 'Image' : 'ImageReference'),
      {method:'markdown',evidence:graph.quote(image),qualifiers:{resolved:!!uri,target:image}});
  }
  for (const reference of parsed.documents ?? []) {
    const uri = file.documentTargets?.[reference.target];
    const key = uri ?? `${file.noteUri}#document-reference:${reference.target}`;
    const target = graph.entity(key,basename(reference.target),uri ? 'Document' : 'DocumentReference');
    graph.link(note,'REFERENCES',target,{method:'document-link',evidence:graph.quote(reference.raw),
      qualifiers:{resolved:!!uri,vault:localUri(vault.path),...JSON.parse(JSON.stringify(reference))}});
  }
  for (const snippet of memory.snippets) if (snippet.kind === 'derived') {
    const originalChunkIndex = snippet.locator.originalChunkIndex;
    graph.claim(note,'EXPANDED_CONTEXT',{value:snippet.text},{status:'proposed',method:'llm',
      model:snippet.locator.model as string | undefined,
      evidence: originalChunkIndex === undefined ? graph.evidence() :
        graph.evidence(originalChunkIndex,undefined,'generated','mentions')});
  }
  return graph;
}

export function commitImageGraph(sdk: ShaleSDK, sourceId: string, namespace: string,
  image: ParsedImage, vault: VaultContext): SourceGraph {
  image = image.memory ? image : { ...image, memory: prepareSourceMemory(image.contextualChunks, { title: image.imageTitle, summary: image.description }) };
  const memory = image.memory!;
  const graph = new SourceGraph(sdk.database,sdk.graph,sourceId,namespace,image.updatedAt);
  const entity = graph.entity(image.imageUri,image.imageTitle,'Image');
  linkVaultMembership(graph,entity,vault);
  graph.claim(entity,'SOURCE_URI',{value:image.imageUri});
  if (image.assetHash) graph.claim(entity,'ASSET_SHA256',{value:image.assetHash});
  const knowledge = memory.snippets.filter(snippet => snippet.locator.originalChunkIndex !== undefined).map(snippet => ({
    predicate: String(snippet.locator.predicate ?? 'VISUAL_DESCRIPTION'), value: snippet.text,
    chunkIndex: snippet.locator.originalChunkIndex!, status: 'proposed' as const,
    method: String(snippet.locator.origin ?? 'vision'), model: snippet.locator.model as string | undefined,
  }));
  commitPreparedClaims(graph,entity,knowledge);
  return graph;
}
