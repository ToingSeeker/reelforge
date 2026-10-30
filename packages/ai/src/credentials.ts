// API keys live in the OS keychain (written by the desktop shell) and reach
// the engine over its stdin; here they are held in memory only. The CLI falls
// back to the environment / an `ant auth login` profile.

const keys = new Map<string, string>();

export function setCredential(provider: string, key: string | null): void {
  if (key) keys.set(provider, key);
  else keys.delete(provider);
}

export function getCredential(provider: string): string | undefined {
  return keys.get(provider);
}

/** Where a provider's key would come from (never the key itself). */
export function credentialSource(provider: string): "keychain" | "environment" | "none" {
  if (keys.has(provider)) return "keychain";
  if (provider === "anthropic" && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE)) return "environment";
  return "none";
}
