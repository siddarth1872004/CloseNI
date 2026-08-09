const fs = require("fs");
const path = require("path");

function writeFile(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  console.log(`  ✅ ${filePath}`);
}

console.log("\n🔧 Setting up project files...\n");

// ============================================
// ROOT FILES
// ============================================

writeFile("package.json", JSON.stringify({
  name: "agentic-web-coder",
  version: "0.1.0",
  private: true,
  workspaces: ["shared", "local-agent", "vscode-extension"],
  scripts: { build: "npm run build --workspaces --if-present" },
  devDependencies: { typescript: "^5.5.4", "@types/node": "^20.0.0" }
}, null, 2));

writeFile("tsconfig.base.json", JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    lib: ["ES2022"],
    types: ["node"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    declaration: true,
    sourceMap: true
  }
}, null, 2));

writeFile(".gitignore", `node_modules/
dist/
out/
*.log
.env
.env.*
.vscode-test/
*.vsix
.DS_Store
Thumbs.db
local-agent/storage/runs/*
!local-agent/storage/runs/.gitkeep
local-agent/storage/backups/*
!local-agent/storage/backups/.gitkeep
local-agent/storage/browser-profiles/*
!local-agent/storage/browser-profiles/.gitkeep
`);

// ============================================
// SHARED PACKAGE
// ============================================

writeFile("shared/package.json", JSON.stringify({
  name: "@agentic/shared",
  version: "0.1.0",
  private: true,
  main: "dist/index.js",
  types: "dist/index.d.ts",
  scripts: { build: "tsc -p tsconfig.json" }
}, null, 2));

writeFile("shared/tsconfig.json", JSON.stringify({
  extends: "../tsconfig.base.json",
  compilerOptions: { outDir: "dist", rootDir: "src" },
  include: ["src"]
}, null, 2));

writeFile("shared/src/index.ts", `export * from "./types";
export * from "./provider-types";
export * from "./patch-types";
export * from "./utils";
`);

writeFile("shared/src/types.ts", `import type { EditPlan, PatchApplyResult } from "./patch-types";
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
`);

writeFile("shared/src/provider-types.ts", `export type ProviderKind = "web" | "local" | "mock";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  requiresLogin?: boolean;
  enabled?: boolean;
  description?: string;
}

export interface ProviderGenerationOptions {
  headless?: boolean;
  timeoutMs?: number;
  profileDir?: string;
  newChat?: boolean;
}

export interface ProviderAnswer {
  providerId: string;
  markdown: string;
  html?: string;
  rawText?: string;
  chatUrl?: string;
  screenshots?: string[];
  logs?: string[];
  timestamp: string;
}
`);

writeFile("shared/src/patch-types.ts", `export type PatchMode = "create" | "overwrite" | "search_replace";

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
`);

writeFile("shared/src/utils.ts", `export function nowIso(): string {
  return new Date().toISOString();
}

export function createTaskId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(16).slice(2, 10);
  return \`task-\${timestamp}-\${random}\`;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function truncateText(text: string, maxLength = 2000): string {
  if (text.length <= maxLength) return text;
  return \`\${text.slice(0, maxLength)}\\n\\n[truncated]\`;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
`);

// ============================================
// LOCAL-AGENT PACKAGE
// ============================================

writeFile("local-agent/package.json", JSON.stringify({
  name: "@agentic/local-agent",
  version: "0.1.0",
  private: true,
  main: "dist/index.js",
  scripts: {
    build: "tsc -p tsconfig.json",
    start: "node dist/index.js"
  },
  dependencies: { "@agentic/shared": "*" },
  devDependencies: { "@types/node": "^20.0.0", typescript: "^5.5.4" }
}, null, 2));

writeFile("local-agent/tsconfig.json", JSON.stringify({
  extends: "../tsconfig.base.json",
  compilerOptions: { outDir: "dist", rootDir: "src" },
  include: ["src"]
}, null, 2));

writeFile("local-agent/src/parser/patch-parser.ts", `import { EditPlan, FileChange, PatchMode } from "@agentic/shared";

export function parseMarkdownToEditPlan(markdown: string): EditPlan {
  const changes: FileChange[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const regex = /\`\`\`(\\w+)?\\s+file="([^"]+)"\\s+mode="(create|overwrite|search_replace)"\\s*\\n([\\s\\S]*?)\`\`\`/g;

  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const language = match[1] || "text";
    const filePath = match[2];
    const mode = match[3] as PatchMode;
    let content = match[4];

    if (content.endsWith("\\n")) {
      content = content.slice(0, -1);
    }

    const change: FileChange = { filePath, mode, language };

    if (mode === "create" || mode === "overwrite") {
      change.newContent = content;
    } else if (mode === "search_replace") {
      const searchMatch = content.match(/<<<<<<< SEARCH\\n([\\s\\S]*?)\\n=======\\n([\\s\\S]*?)\\n>>>>>>> REPLACE/);
      if (searchMatch) {
        change.searchBlock = searchMatch[1];
        change.replaceBlock = searchMatch[2];
      } else {
        errors.push(\`Invalid search_replace format in file: \${filePath}\`);
        continue;
      }
    }

    changes.push(change);
  }

  if (changes.length === 0 && markdown.trim().length > 0) {
    warnings.push("No valid patch blocks found in the response.");
  }

  return { changes, warnings, errors, rawMarkdown: markdown };
}
`);

writeFile("local-agent/src/patch/patch-applier.ts", `import * as fs from "fs";
import * as path from "path";
import { EditPlan, FileChange, PatchApplyResult } from "@agentic/shared";

export function applyPatch(workspaceRoot: string, plan: EditPlan): PatchApplyResult {
  const appliedFiles: string[] = [];
  const errors: string[] = [];
  const backupDir = path.join(workspaceRoot, ".agent-backups", Date.now().toString());
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);

  for (const change of plan.changes) {
    try {
      const absoluteFilePath = path.resolve(workspaceRoot, change.filePath);

      if (!absoluteFilePath.startsWith(absoluteWorkspaceRoot)) {
        throw new Error(\`Security Error: Attempted to write outside workspace: \${change.filePath}\`);
      }

      const dir = path.dirname(absoluteFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(absoluteFilePath)) {
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const backupPath = path.join(backupDir, change.filePath);
        const backupFileDir = path.dirname(backupPath);
        if (!fs.existsSync(backupFileDir)) fs.mkdirSync(backupFileDir, { recursive: true });
        fs.copyFileSync(absoluteFilePath, backupPath);
      }

      if (change.mode === "create" || change.mode === "overwrite") {
        if (change.mode === "create" && fs.existsSync(absoluteFilePath)) {
          throw new Error(\`File already exists: \${change.filePath}\`);
        }
        fs.writeFileSync(absoluteFilePath, change.newContent || "");
      } else if (change.mode === "search_replace") {
        if (!fs.existsSync(absoluteFilePath)) {
          throw new Error(\`File not found for search_replace: \${change.filePath}\`);
        }
        const originalContent = fs.readFileSync(absoluteFilePath, "utf-8");
        if (!originalContent.includes(change.searchBlock || "")) {
          throw new Error(\`Search block not found in \${change.filePath}\`);
        }
        const newContent = originalContent.replace(change.searchBlock || "", change.replaceBlock || "");
        fs.writeFileSync(absoluteFilePath, newContent, "utf-8");
      }

      appliedFiles.push(change.filePath);
      console.log(\`✅ Applied \${change.mode} to: \${change.filePath}\`);
    } catch (error: any) {
      const errMsg = \`❌ Failed to apply \${change.filePath}: \${error.message}\`;
      errors.push(errMsg);
      console.error(errMsg);
    }
  }

  return {
    success: errors.length === 0,
    appliedFiles,
    backupDir: fs.existsSync(backupDir) ? backupDir : undefined,
    errors,
  };
}
`);

writeFile("local-agent/src/index.ts", `import * as path from "path";
import { parseMarkdownToEditPlan } from "./parser/patch-parser.js";
import { applyPatch } from "./patch/patch-applier.js";

const fakeAIResponse = \`
I can help you fix that bug! Here is the corrected math function:

\\\`\\\`\\\`typescript file="src/utils.ts" mode="search_replace"
<<<<<<< SEARCH
export function add(a: number, b: number) {
  return a - b;
}
=======
export function add(a: number, b: number) {
  return a + b;
}
>>>>>>> REPLACE
\\\`\\\`\\\`

I also created a new config file for you:

\\\`\\\`\\\`typescript file="src/config.ts" mode="create"
export const MAX_RETRIES = 3;
export const API_TIMEOUT = 5000;
\\\`\\\`\\\`
\`;

const dummyWorkspace = path.resolve(__dirname, "../../samples/dummy-workspace");

async function runAgent() {
  console.log("🤖 Agent starting...");
  console.log(\`📁 Workspace: \${dummyWorkspace}\\n\`);

  console.log("🧠 Parsing AI response...");
  const editPlan = parseMarkdownToEditPlan(fakeAIResponse);

  if (editPlan.changes.length === 0) {
    console.log("No changes found in AI response.");
    return;
  }

  console.log("🛠️  Applying patch to workspace...\\n");
  const result = applyPatch(dummyWorkspace, editPlan);

  console.log("\\n--- AGENT RUN COMPLETE ---");
  console.log(\`Success: \${result.success}\`);
  console.log(\`Files modified: \${result.appliedFiles.join(", ")}\`);
  if (result.backupDir) {
    console.log(\`Backups saved to: \${result.backupDir}\`);
  }
}

runAgent().catch(console.error);
`);

// ============================================
// VS CODE EXTENSION (minimal for now)
// ============================================

writeFile("vscode-extension/package.json", JSON.stringify({
  name: "@agentic/vscode-extension",
  version: "0.1.0",
  private: true,
  main: "./dist/extension.js",
  scripts: { build: "tsc -p tsconfig.json" },
  dependencies: { "@agentic/shared": "*" },
  devDependencies: { "@types/node": "^20.0.0", typescript: "^5.5.4" }
}, null, 2));

writeFile("vscode-extension/tsconfig.json", JSON.stringify({
  extends: "../tsconfig.base.json",
  compilerOptions: { outDir: "dist", rootDir: "src" },
  include: ["src"]
}, null, 2));

writeFile("vscode-extension/src/extension.ts", `// VS Code Extension entry point - will be built in Phase 6
export function activate() {
  console.log("Agent extension activated");
}
`);

// ============================================
// SAMPLES
// ============================================

writeFile("samples/dummy-workspace/src/utils.ts", `export function add(a: number, b: number) {
  return a - b; // BUG: Should be a + b
}

export function multiply(a: number, b: number) {
  return a * b;
}
`);

// ============================================
// EMPTY PLACEHOLDER FILES
// ============================================

const emptyFiles = [
  "local-agent/src/orchestrator.ts",
  "local-agent/src/task-manager.ts",
  "local-agent/src/conversation-manager.ts",
  "local-agent/src/parser/markdown-cleaner.ts",
  "local-agent/src/parser/edit-plan-builder.ts",
  "local-agent/src/patch/patch-validator.ts",
  "local-agent/src/patch/backup-manager.ts",
  "local-agent/src/patch/sandbox.ts",
  "local-agent/src/providers/provider-registry.ts",
  "local-agent/src/providers/provider-types.ts",
  "local-agent/src/providers/playwright-controller.ts",
  "local-agent/src/providers/deepseek.adapter.ts",
  "local-agent/src/providers/qwen-studio.adapter.ts",
  "local-agent/src/providers/huggingchat.adapter.ts",
  "local-agent/src/providers/open-webui.adapter.ts",
  "local-agent/src/prompts/question-builder.ts",
  "local-agent/src/prompts/followup-builder.ts",
  "local-agent/src/prompts/patch-format.ts",
  "local-agent/src/verification/syntax-checker.ts",
  "local-agent/src/verification/lint-runner.ts",
  "local-agent/src/verification/test-runner.ts",
  "local-agent/src/verification/error-collector.ts",
  "local-agent/src/context/file-indexer.ts",
  "local-agent/src/context/keyword-search.ts",
  "local-agent/src/context/context-packager.ts",
  "local-agent/src/context/optional-vector-search.ts",
  "local-agent/src/memory/sqlite-store.ts",
  "local-agent/src/memory/task-history.ts",
  "local-agent/src/memory/error-memory.ts",
  "local-agent/src/local-llm/ollama-client.ts",
  "local-agent/src/local-llm/response-repair.ts",
  "local-agent/src/local-llm/error-summarizer.ts",
  "local-agent/config/providers/deepseek.json",
  "local-agent/config/providers/qwen-studio.json",
  "local-agent/config/providers/huggingchat.json",
  "local-agent/config/providers/open-webui.json",
  "local-agent/config/safety.json",
  "local-agent/storage/runs/.gitkeep",
  "local-agent/storage/backups/.gitkeep",
  "local-agent/storage/browser-profiles/.gitkeep",
  "vscode-extension/src/agent-client.ts",
  "vscode-extension/src/provider-picker.ts",
  "vscode-extension/src/context-picker.ts",
  "vscode-extension/src/diff-view.ts",
  "vscode-extension/src/approval-view.ts",
  "vscode-extension/src/history-view.ts",
  "vscode-extension/src/logs.ts",
  "samples/mock-answers/deepseek-create-file.md",
  "samples/mock-answers/deepseek-search-replace.md",
  "samples/mock-answers/qwen-create-file.md",
  "samples/mock-answers/qwen-search-replace.md",
  "samples/mock-answers/broken-answer.md",
  "samples/mock-answers/explanation-only.md",
  "samples/dummy-workspace/README.md",
  "samples/tasks/example-task.json",
  "README.md"
];

emptyFiles.forEach(f => writeFile(f, ""));

console.log("\n🎉 All files created successfully!\n");
console.log("Next steps:");
console.log("  1. npm install");
console.log("  2. npm run build");
console.log("  3. node local-agent/dist/index.js");
console.log("");