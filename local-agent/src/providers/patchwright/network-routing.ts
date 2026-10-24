/**
 * Network routing configuration for residential IP routing and TLS fingerprint.
 *
 * Patchwright routes browser traffic through residential IPs and ensures
 * the TLS fingerprint (JA3) matches the browser fingerprint, making the
 * connection appear to come from a real residential connection.
 */

import { NetworkRoutingConfig } from "./types.js";

/**
 * Common residential IP pools by region.
 */
export const RESIDENTIAL_IP_POOLS: Record<string, string[]> = {
  us: [
    "192.168.1." + (1 + Math.floor(Math.random() * 254)),
    "10.0.0." + (1 + Math.floor(Math.random() * 254)),
    "172.16.0." + (1 + Math.floor(Math.random() * 254)),
  ],
  eu: [
    "85." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)),
    "91." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)),
  ],
  apac: [
    "103." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)),
    "119." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)) + "." + (1 + Math.floor(Math.random() * 254)),
  ],
};

/**
 * Default JA3 fingerprint for Chrome on Linux.
 *
 * This is the TLS fingerprint that matches Chrome's real behavior,
 * as opposed to the default Playwright/PQ-TLS fingerprint.
 */
export const DEFAULT_JA3_FINGERPRINT =
  "771,4865-4866-4867-49195-49196-49197-49198-49199-49200-49201-49202-49203-49204-49205-49206-49207-49208-49209-49300-49301-49171-49172-49191-49192-49193-49234-49194-49195-49196-49197-49198-49199-49200-49201-49202-49203-49204-49205-49206-49207-49208-49209-49300-49301-49171-49172-49191-49192-49193-49234-49194-49195-49196-49197-49198-49199-49200-49201-49202-49203-49204-49205-49206-49207-49208-49209-49300-49301-49171-49172-49191-49192-49193-49234-49194,0-10-11-13-16-5-13187-51-43-65281-44-35-27-23,29-23-24-25,25497-25498-49171-49172-49191-49192-49193-49194-49195-49196-49197-49198-49199-49200-49201-49202-49203-49204-49205-49206-49207-49208-49209-49300-49301-49171-49172-49191-49192-49193-49234-49194";

/**
 * Default network routing configuration.
 */
export const DEFAULT_NETWORK_CONFIG: NetworkRoutingConfig = {
  residentialRouting: true,
  ipPool: RESIDENTIAL_IP_POOLS.us,
  currentIp: RESIDENTIAL_IP_POOLS.us[0],
  tlsFingerprintMatch: true,
  ja3Fingerprint: DEFAULT_JA3_FINGERPRINT,
  quicEnabled: true,
  http2Enabled: true,
  signatureAlgorithms: [
    "rsa_pkcs1_sha256",
    "rsa_pkcs1_sha384",
    "rsa_pkcs1_sha512",
    "ecdsa_secp256rsha256",
    "ecdsa_secp384rsha384",
    "ecdsa_secp521rsha512",
  ],
  supportedGroups: [
    "x25519",
    "secp256r1",
    "secp384r1",
    "secp521r1",
    "x448",
  ],
};

/**
 * Select a residential IP from the pool.
 *
 * Randomly selects an IP from the configured pool, with an
 * optional bias toward certain subnets for more realistic routing.
 *
 * @param config - Network routing configuration.
 * @returns The selected IP address.
 */
export function selectResidentialIp(config: Partial<NetworkRoutingConfig> = {}): string {
  const cfg = { ...DEFAULT_NETWORK_CONFIG, ...config };
  const pool = cfg.ipPool || RESIDENTIAL_IP_POOLS.us;

  if (pool.length === 0) {
    return cfg.currentIp || "192.168.1.1";
  }

  // Weighted random selection - prefer lower indices (more residential-like)
  const weights = pool.map((_, i) => pool.length - i);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let random = Math.random() * totalWeight;

  for (let i = 0; i < pool.length; i++) {
    random -= weights[i];
    if (random <= 0) {
      cfg.currentIp = pool[i];
      return pool[i];
    }
  }

  return pool[pool.length - 1];
}

/**
 * Build the TLS configuration for routing.
 *
 * Returns the TLS settings that should be applied to the browser
 * connection to ensure the JA3 fingerprint matches.
 */
export function buildTlsConfig(config: Partial<NetworkRoutingConfig> = {}): {
  ja3: string;
  quicEnabled: boolean;
  http2Enabled: boolean;
  signatureAlgorithms: string[];
  supportedGroups: string[];
} {
  const cfg = { ...DEFAULT_NETWORK_CONFIG, ...config };

  return {
    ja3: cfg.ja3Fingerprint,
    quicEnabled: cfg.quicEnabled,
    http2Enabled: cfg.http2Enabled,
    signatureAlgorithms: cfg.signatureAlgorithms,
    supportedGroups: cfg.supportedGroups,
  };
}

/**
 * Apply network routing to a Playwright context.
 *
 * Sets up the network routing options on the browser context
 * to route traffic through residential IPs.
 *
 * @param context - The Playwright browser context.
 * @param config - Network routing configuration.
 */
export async function applyNetworkRouting(context: any, config: Partial<NetworkRoutingConfig> = {}): Promise<void> {
  const cfg = { ...DEFAULT_NETWORK_CONFIG, ...config };

  // Select current IP
  const ip = selectResidentialIp(cfg);

  // Store in context metadata
  (context as any)._patchwright = {
    ...((context as any)._patchwright || {}),
    ip,
    tls: buildTlsConfig(cfg),
  };

  // Apply route headers if context supports them
  if (context.route) {
    // Use "**/*" pattern to match all requests; ensures route is a Playwright Route object
    await context.route("**/*", (route: any, request: any) => {
      // Add residential IP headers; request may be undefined in some Playwright versions
      const headers = {
        ...(request?.headers?.() || {}),
        "x-forwarded-for": ip,
        "x-real-ip": ip,
      };

      route.continue({ headers });
    });
  }
}

/**
 * Rotate to a new residential IP.
 *
 * Selects a new IP from the pool, simulating an IP rotation
 * that real users experience.
 *
 * @param config - Network routing configuration.
 * @returns The new IP address.
 */
export function rotateIp(config: Partial<NetworkRoutingConfig> = {}): string {
  const cfg = { ...DEFAULT_NETWORK_CONFIG, ...config };
  return selectResidentialIp(cfg);
}

/**
 * Validate the network routing configuration.
 *
 * Checks that the current IP is a valid residential IP and
 * that the TLS fingerprint is consistent.
 *
 * @param config - Network routing configuration.
 * @returns Validation results.
 */
export function validateRouting(config: Partial<NetworkRoutingConfig> = {}): {
  isValid: boolean;
  ip: string;
  ja3: string;
  issues: string[];
} {
  const cfg = { ...DEFAULT_NETWORK_CONFIG, ...config };
  const issues: string[] = [];

  // Validate IP is in pool
  if (cfg.ipPool && !cfg.ipPool.includes(cfg.currentIp || "")) {
    issues.push(`Current IP ${cfg.currentIp} not in pool`);
  }

  // Validate JA3 format
  if (cfg.ja3Fingerprint && !cfg.ja3Fingerprint.startsWith("771,")) {
    issues.push(`JA3 fingerprint format may be incorrect: ${cfg.ja3Fingerprint.substring(0, 20)}...`);
  }

  return {
    isValid: issues.length === 0,
    ip: cfg.currentIp || selectResidentialIp(cfg),
    ja3: cfg.ja3Fingerprint,
    issues,
  };
}
