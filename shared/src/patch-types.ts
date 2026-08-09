export type PatchMode = "create" | "overwrite" | "search_replace";

export interface FileChange {
  filePath: string;
  mode: PatchMode;
  language?: string;
  newContent?: string;
  searchBlock?: string;
  replaceBlock?: string;
  explanation?: string;
}

export interface EditPlan {
  changes: FileChange[];
  warnings: string[];
  errors: string[];
  commands?: string[];
  rawMarkdown?: string;
}

export interface PatchValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface PatchApplyResult {
  success: boolean;
  appliedFiles: string[];
  backupDir?: string;
  errors: string[];
}
