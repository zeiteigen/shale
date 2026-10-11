export interface DbBackupSettings {
  /**
   * Whether automated database backup is enabled.
   */
  enabled: boolean;

  /**
   * Whether to create a backup every time the Shale host program launches.
   */
  backupOnStartup: boolean;

  /**
   * Target directory path where backups will be stored (relative to project root or absolute).
   */
  backupDir: string;

  /**
   * Prefix for generated backup filenames.
   */
  filenamePrefix: string;

  /**
   * Maximum number of recent backups to retain (0 for unlimited).
   */
  maxBackups: number;

  /** Maximum age in days for matching backup files; expired files are removed even when count retention is unlimited. */
  maxAgeDays: number;

  /**
   * Timestamp format appended to backup filenames ("iso" or "unix").
   */
  timestampFormat: "iso" | "unix";
}

export interface BackupResult {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  backupPath?: string;
  filename?: string;
  sizeBytes?: number;
  prunedCount?: number;
  timestamp?: string;
}
