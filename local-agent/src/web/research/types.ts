/**
 * The research engine's vocabulary. Search-engine-specific shapes never cross
 * this line: every backend produces SearchResult, every fetch produces WebPage.
 */
import { Block } from "../semantic/blocks.js";

export type SearchStrategy =
  | "broad" | "exact" | "site" | "official" | "documentation" | "github"
  | "academic" | "news" | "recency" | "technical";

export type SourceType =
  | "documentation" | "official" | "code-repository" | "encyclopedia" | "news" | "academic"
  | "forum" | "blog" | "search-engine" | "ai-answer" | "unknown";

export interface SearchQuery {
  text: string;
  strategy: SearchStrategy;
  /** Which subquestion this query serves. */
  subquestionId: string;
  site?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  canonical_url: string;
  domain: string;
  snippet: string;
  source_type: SourceType;
  published_at?: string;
  discovered_at: string;
  search_query: string;
  /** Signals, never collapsed into one "quality" number. */
  relevance: { query: number; rank: number; backend: string };
  duplicate_group?: string;
  metadata: Record<string, unknown>;
}

export interface Section {
  id: string;
  /** Heading texts from the page title down to this section. */
  path: string[];
  level: number;
  heading: string;
  blocks: Block[];
  /** Character offset of this section within the page's main text. */
  offset: number;
}

export interface PageLink {
  text: string;
  href: string;
  canonical: string;
  headingPath: string[];
  inMain: boolean;
  rel?: string;
}

export interface WebPage {
  url: string;
  canonical_url: string;
  final_url: string;
  title: string;
  description: string;
  language: string;
  metadata: Record<string, string>;
  published_at?: string;
  headings: Array<{ level: number; text: string }>;
  sections: Section[];
  paragraphs: string[];
  lists: string[][];
  tables: Array<{ caption?: string; header: string[]; rows: string[][]; headingPath: string[] }>;
  code_blocks: Array<{ lang: string; text: string; headingPath: string[] }>;
  links: PageLink[];
  images: Array<{ src: string; alt: string }>;
  /** How the main content was chosen, and how confident each method was. */
  main_content: { method: string; votes: Record<string, string>; textChars: number; boilerplateRemoved: number };
  /** Full-page text vs main text, for the "cheapest representation" choice. */
  text: string;
  main_text: string;
  source_type: SourceType;
  fetched_at: string;
  fetch: { mode: "http" | "browser" | "cache"; status?: number; durationMs: number; representation: number };
  content_hash: string;
}

export interface Chunk {
  id: string;
  url: string;
  title: string;
  headingPath: string[];
  text: string;
  /** Position among the page's chunks, and character offset in main_text. */
  position: number;
  offset: number;
  source_type: SourceType;
  retrieved_at: string;
  kind: "prose" | "code" | "table" | "list";
}

export interface RelevanceSignals {
  lexical: number;
  headingMatch: number;
  titleMatch: number;
  coverage: number;
  sourceType: SourceType;
  freshnessDays?: number;
  position: number;
}

export interface ScoredChunk { chunk: Chunk; signals: RelevanceSignals; order: number }

/** Where a statement came from, precisely enough to quote it back. */
export interface Provenance {
  url: string;
  title: string;
  section: string[];
  /** The exact span within the chunk text. */
  span: { start: number; end: number; text: string };
  retrieved_at: string;
  source_type: SourceType;
}

export interface Claim {
  id: string;
  text: string;
  subject: string;
  /** Numbers the claim asserts, with units when present. */
  quantities: Array<{ value: number; unit: string; raw: string }>;
  negated: boolean;
  subquestionId?: string;
}

export interface Evidence {
  id: string;
  claim: Claim;
  provenance: Provenance;
  chunkId: string;
  signals: RelevanceSignals;
}

export interface Conflict {
  id: string;
  topic: string;
  a: Evidence;
  b: Evidence;
  kind: "numeric" | "polarity";
  context: string;
}

export interface Subquestion {
  id: string;
  text: string;
  strategies: SearchStrategy[];
  /** Words that must appear for a source to count as covering this. */
  focus: string[];
  /**
   * The focus words that tell this subquestion apart from its siblings. In
   * "Widget Engine rate limits" vs "Widget Engine performance", "widget engine"
   * matches everything; "rate limits" is what makes a sentence evidence for
   * the first. Empty when the subquestion has no such words.
   */
  distinctive?: string[];
}

export interface ResearchPlan {
  question: string;
  subquestions: Subquestion[];
  method: "heuristic" | "model" | "model+heuristic";
}
