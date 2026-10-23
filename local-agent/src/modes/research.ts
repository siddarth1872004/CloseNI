/**
 * Research mode: one question answered through the provider's own search.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import { ProviderRegistry } from "../providers/provider-registry.js";
import { ChatSession, isBrowserTransport } from "../providers/chat-session.js";
import { hasSearchControl, extractSources, RESEARCH_PROMPT_PREFIX } from "../research.js";
import { emit } from "../cli-io.js";
import { openChatSession, forceControl } from "./provider.js";

export async function researchMode(query: string, workspace: string, providerId: string) {
  const registry = new ProviderRegistry();
  registry.loadProviders();
  const config = registry.getUsableProvider(providerId);
  if (!config) { emit({ success: false, web: [], error: "Provider not found: " + providerId }); return; }

  if (!isBrowserTransport(config as any)) {
    emit({ success: false, web: [],
      error: config.name + " has no web search. Switch to DeepSeek in Settings for research." });
    return;
  }
  if (!hasSearchControl(config)) {
    emit({ success: false, web: [],
      error: config.name + " does not offer a web search control, so research cannot use it. " +
        "Ask in Chat instead." });
    return;
  }

  forceControl("smart-search", true);
  let session: ChatSession | null = null;
  try {
    const opened = await openChatSession(providerId, workspace);
    session = opened.session;
    const answer = await session.ask(RESEARCH_PROMPT_PREFIX + query);
    emit({
      success: true,
      answer: answer,
      sources: extractSources(answer),
      via: config.name + " with web search on",
    });
  } catch (e: any) {
    emit({ success: false, web: [], error: e && e.message ? e.message : String(e) });
  } finally {
    if (session) await session.close();
  }
}
