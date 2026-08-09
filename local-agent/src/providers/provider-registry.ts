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
        console.log(`📋 Loaded provider: ${config.name} (${config.id})`);
      } catch (error: any) {
        console.error(`❌ Failed to load provider config: ${file} - ${error.message}`);
      }
    }
  }

  getProvider(id: string): ProviderConfig | undefined {
    return this.providers.get(id);
  }

  listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values()).filter(p => p.enabled);
  }
}
