import { createHash } from "node:crypto";
import type { ShaleSDK } from '@shale/sdk';
import type { ParsedFile } from './parse-file';
import type { ParsedImage } from './parse-image';
import { commitImageGraph, commitNoteGraph, type VaultContext } from './graph';
import { recordCommittedFile } from './file-progress';

/** All durable source, evidence, graph, and checkpoint changes commit together. */
export function commitNote(sdk: ShaleSDK, file: ParsedFile,
  vault: VaultContext, namespace = 'obsidian', checkpointId?: string) {
  return sdk.database.transaction(() => {
    const result = sdk.ingest.sourceAndChunks({namespace,source:{type:'markdown_note',
      uri:file.noteUri,origin:'obsidian',title:file.noteTitle,updated_at:file.updatedAt},
      chunks:file.contextualChunks});
    if (result.skipped) {
      if (checkpointId) sdk.checkpoint.delete(checkpointId);
      return {...result,edgesCreated:0};
    }
    const graph = commitNoteGraph(sdk,result.sourceId,namespace,file,vault);
    recordCommittedFile(sdk, namespace, file.noteUri, file.updatedAt);
    if (checkpointId) sdk.checkpoint.delete(checkpointId);
    return {...result,edgesCreated:graph.edgesCount};
  })();
}

export function commitImage(sdk: ShaleSDK, image: ParsedImage,
  vault: VaultContext, namespace = 'obsidian', checkpointId?: string) {
  return sdk.database.transaction(() => {
    const chunks = image.contextualChunks?.length ? image.contextualChunks : [image.contextualChunk];
    const result = sdk.ingest.sourceAndChunks({namespace,source:{type:'image',
      uri:image.imageUri,origin:'obsidian',title:image.imageTitle,updated_at:image.updatedAt,
      hash:image.assetHash ? createHash('sha256').update(JSON.stringify([image.imageUri,image.assetHash,chunks.map(c=>c.text_content)])).digest('hex') : undefined},
      // Old checkpoints also contain vision-generated layout; it is always synthetic.
      chunks:chunks.map(chunk => ({...chunk,chunk_type:'synthetic'}))});
    if (result.skipped) {
      if (checkpointId) sdk.checkpoint.delete(checkpointId);
      return {...result,edgesCreated:0};
    }
    const graph = commitImageGraph(sdk,result.sourceId,namespace,{...image,contextualChunks:chunks},vault);
    recordCommittedFile(sdk, namespace, image.imageUri, image.updatedAt);
    if (checkpointId) sdk.checkpoint.delete(checkpointId);
    return {...result,edgesCreated:graph.edgesCount};
  })();
}
