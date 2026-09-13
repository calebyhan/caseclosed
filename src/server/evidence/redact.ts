import { REDACTED, redactSecrets } from "../../domain/secrets";

// Redaction applied before anything reaches observations, artifacts, prompts,
// or the database. Network evidence records method/URL/status only: no
// request headers, cookies, or bodies are collected.

const SENSITIVE_PARAM = /token|secret|password|passwd|key|session|auth|code|signature|cookie|credential/i;

export function redactUrl(url: string, knownSecrets: readonly (string | null | undefined)[] = []): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    for (const name of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) parsed.searchParams.set(name, REDACTED);
    }
    return redactSecrets(parsed.toString(), knownSecrets);
  } catch {
    return redactSecrets(url, knownSecrets);
  }
}

export function redactText(text: string, knownSecrets: readonly (string | null | undefined)[] = []): string {
  return redactSecrets(text, knownSecrets).replace(/\bacme_test_session=[^;\s]+/g, `acme_test_session=${REDACTED}`);
}
