import type { ProcessFileResponse } from "../../lib/messages.types";

export interface DirectoryInfo { path: string; name: string }

export interface DirectoryResult {
  directory: string;
  filesProcessed: number;
  filesSkipped: number;
  chunksCreated: number;
  errors: Array<{ filePath: string; error: string }>;
}

/** Portable Phase 1 output; vectors are always generated again during recovery. */
export interface PreparedDirectoryFile {
  type: "directory_file";
  directory: DirectoryInfo;
  filePath: string;
  namespace: string;
  fingerprint: string;
  updatedAt: number;
  parsed: ProcessFileResponse;
}

export interface PendingDirectoryFile {
  id: string;
  data: PreparedDirectoryFile;
  result: DirectoryResult;
}
