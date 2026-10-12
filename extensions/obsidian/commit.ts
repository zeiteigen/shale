import type { ShaleSDK } from '@shale/sdk';
import type { ParsedFile } from './parse-file';
import type { ParsedImage } from './parse-image';
import { commitImageGraph, commitNoteGraph, type VaultContext } from './graph';
import { recordCommittedFile } from './file-progress';
import { contentFingerprint, memoryChunks, prepareSourceMemory } from '../../lib/memory/prepare';
import { noteNeedsImageCleanup } from './note-relevance';

/** All durable source, evidence, graph, and checkpoint changes commit together. */
export function commitNote(sdk: ShaleSDK, file: ParsedFile,
  vault: VaultContext, namespace = 'obsidian', checkpointId?: string) {
  if (noteNeedsImageCleanup(file)) throw new Error('Decorative images in cached note; reprepare the original file before committing');
  return sdk.database.transaction(() => {
    const memory = file.memory ?? prepareSourceMemory(file.contextualChunks, { title: file.noteTitle });
    const result = sdk.ingest.sourceAndChunks({namespace,source:{type:'markdown_note',
      uri:file.noteUri,origin:'obsidian',title:file.noteTitle,updated_at:file.updatedAt, hash:file.sourceFingerprint ?? contentFingerprint(file.contextualChunks)},
      chunks:memoryChunks(memory), memory});
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
    const sourceMemory = image.memory ?? prepareSourceMemory(image.contextualChunks?.length ? image.contextualChunks : [image.contextualChunk],
      { title: image.imageTitle, summary: image.description });
    const chunks = memoryChunks(sourceMemory);
    const result = sdk.ingest.sourceAndChunks({namespace,source:{type:'image',
      uri:image.imageUri,origin:'obsidian',title:image.imageTitle,updated_at:image.updatedAt,
      hash:image.sourceFingerprint ?? contentFingerprint(image.contextualChunks?.length ? image.contextualChunks : [image.contextualChunk])},
      // Old checkpoints also contain vision-generated layout; it is always synthetic.
      chunks,
      memory:sourceMemory});
    if (result.skipped) {
      if (checkpointId) sdk.checkpoint.delete(checkpointId);
      return {...result,edgesCreated:0};
    }
    const graph = commitImageGraph(sdk,result.sourceId,namespace,{...image,contextualChunks:chunks, memory:sourceMemory},vault);
    recordCommittedFile(sdk, namespace, image.imageUri, image.updatedAt);
    if (checkpointId) sdk.checkpoint.delete(checkpointId);
    return {...result,edgesCreated:graph.edgesCount};
  })();
}
