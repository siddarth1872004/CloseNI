import type { EditPlan, PatchApplyResult } from "./patch-types";
import type { ProviderAnswer } from "./provider-types";

export type TaskStatus =
  | "pending" | "collecting_context" | "asking_provider"
  | "extracting_answer" | "parsing_answer" | "validating_patch"
  | "testing_patch" | "follow_up" | "awaiting_approval"
  | "approved" | "rejected" | "completed" | "failed";

export interface ContextFile {
  filePath: string;
  content: string;
  startLine?: number;
  endLine?: number;
  reason?: string;
}

export interface AgentOptions {
  maxFollowUps?: number;
  dryRun?: boolean;
  autoApply?: boolean;
  includeProjectTree?: boolean;
  timeoutMs?: number;
}

export interface AgentRequest {
  taskId?: string;
  workspaceRoot: string;
  prompt: string;
  providerId: string;
  activeFile?: string;
  selection?: string;
  contextFiles?: ContextFile[];
  options?: AgentOptions;
}

export interface ChatExchange {
  role: "question" | "answer" | "followup";
  content: string;
  timestamp: string;
  providerId?: string;
}

export interface VerificationResult {
  success: boolean;
  command?: string;
  errors: string[];
  warnings: string[];
  rawOutput?: string;
}

export interface TaskArtifact {
  path: string;
  type: "screenshot" | "html" | "markdown" | "log" | "json";
}

export interface AgentResult {
  taskId: string;
  success: boolean;
  status: TaskStatus;
  providerId?: string;
  editPlan?: EditPlan;
  providerAnswers?: ProviderAnswer[];
  exchanges?: ChatExchange[];
  verification?: VerificationResult;
  patchResult?: PatchApplyResult;
  errors?: string[];
  logs?: string[];
  artifacts?: TaskArtifact[];
}
