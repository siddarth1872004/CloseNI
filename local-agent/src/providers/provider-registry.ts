import * as fs from "fs";
import * as path from "path";
import { ProviderConfig } from "./playwright-controller.js";

export class ProviderRegistry {
  private providers: Map<string, ProviderConfig> = new Map();

  loadProviders(): void {
    // AGENT_PROVIDER_DIR lets tests point at fixture providers without touching
    // the shipped config.
    const configDir = process.env.AGENT_PROVIDER_DIR
      ? path.resolve(process.env.AGENT_PROVIDER_DIR)
      : path.resolve(__dirname, "../../config/providers");

    if (!fs.existsSync(configDir)) {
      console.log("No provider config directory found.");
      return;
    }

    const files = fs.readdirSync(configDir).filter(f => f.endsWith(".json"));
    
    for (const file of files) {
      try {
        const filePath = path.join(configDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const config: ProviderConfig = JSON.parse(content);
        this.providers.set(config.id, config);
        console.log(`Loaded provider: ${config.name} (${config.id})`);
      } catch (error: any) {
        console.error(`Failed to load provider config: ${file} - ${error.message}`);
      }
    }
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  /**
   * Why this exists separately from getProvider: the settings panel has to
   * list the coming-soon providers in order to show them as coming soon, so
   * the lookup cannot refuse them. Everything that actually drives a browser
   * goes through here instead, which means a stale saved preference or a
   * direct CLI call cannot start a session on a provider we know is broken.
   */
  getUsableProvider(id: string): ProviderConfig | undefined {
    const config = this.providers.get(id);
    if (config && config.comingSoon) {
      throw new Error(
        config.name + " is not available yet - it is marked coming soon. " +
        "Choose DeepSeek Chat in Settings.",
      );
    }
    return config;
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values()).filter(p => p.enabled);
  }
}
