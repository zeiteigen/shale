import { basename, dirname, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ParsedFile } from './parse-file';
import { isDecorativeImageUrl } from '../../lib/decorative-images';

/** Build once per discovery batch; retain resolutions in the checkpoint. */
export function createNoteIndex(paths: string[]) {
  const byName = new Map<string,string[]>();
  const files = new Set(paths.map(path => resolve(path)));
  for (const path of files) {
    const name = basename(path);
    byName.set(name,[...(byName.get(name) ?? []),path]);
  }
  return {files,byName};
}

/** Standalone ingestion uses the same resolver without importing the vault runner. */
export function indexVault(root: string, ignoredDirectories: string[] = []) {
  const paths: string[] = [];
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (entry.name.startsWith('.') || ignoredDirectories.includes(entry.name)) continue;
      const path = resolve(dir,entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  scan(root);
  return createNoteIndex(paths);
}

export function resolveNoteLinks(file: ParsedFile, vaultPath: string, index: ReturnType<typeof createNoteIndex>) {
  const targets: Record<string,string> = {};
  for (const target of file.parsed.wikilinks) {
    const name = /\.md$/i.test(target) ? target : `${target}.md`;
    const candidates = [...new Set([resolve(dirname(file.filePath),name),resolve(vaultPath,name)])]
      .filter(path => index.files.has(path));
    const matches = candidates.length ? candidates : target.includes('/') ? [] : index.byName.get(name) ?? [];
    if (matches.length === 1) targets[target] = matches[0];
  }
  file.linkTargets = targets;
  file.assetTargets = {};
  for (const target of file.parsed.images) {
    if (isDecorativeImageUrl(target)) continue;
    if (/^https?:\/\//.test(target)) { file.assetTargets[target] = target; continue; }
    const candidates = [...new Set([resolve(dirname(file.filePath),target),resolve(vaultPath,target)])]
      .filter(path=>index.files.has(path));
    const matches = candidates.length ? candidates : target.includes('/') ? [] : index.byName.get(target) ?? [];
    if (matches.length === 1) file.assetTargets[target] = `file://${matches[0]}`;
  }
  file.documentTargets = {};
  for (const {target} of file.parsed.documents ?? []) {
    const candidates = [...new Set([resolve(dirname(file.filePath),target),resolve(vaultPath,target)])]
      .filter(path => index.files.has(path));
    const matches = candidates.length ? candidates : target.includes('/') ? [] : index.byName.get(target) ?? [];
    if (matches.length === 1) file.documentTargets[target] = pathToFileURL(matches[0]).href;
  }
}
