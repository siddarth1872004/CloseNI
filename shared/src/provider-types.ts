export type ProviderKind = "web" | "local" | "mock";

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
