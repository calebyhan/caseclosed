// Credential detection shared by spec validation, prompt construction and
// evidence redaction. Pattern-based detection is a backstop; known configured
// secret values are always matched exactly.

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|authorization)\s*[:=]\s*\S+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
];

export const REDACTED = "[REDACTED]";

/** Secrets shorter than this are not matched verbatim (too many false positives). */
const MIN_KNOWN_SECRET_LENGTH = 8;

function usableSecrets(knownSecrets: readonly (string | null | undefined)[]): string[] {
  return knownSecrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= MIN_KNOWN_SECRET_LENGTH);
}

export function containsSecret(text: string, knownSecrets: readonly (string | null | undefined)[] = []): boolean {
  if (usableSecrets(knownSecrets).some((secret) => text.includes(secret))) return true;
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function redactSecrets(text: string, knownSecrets: readonly (string | null | undefined)[] = []): string {
  let result = text;
  for (const secret of usableSecrets(knownSecrets)) result = result.split(secret).join(REDACTED);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

/** Every string value in a JSON-like structure, with its dotted path. */
export function stringLeaves(value: unknown, path = ""): Array<{ path: string; value: string }> {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(item, path ? `${path}.${key}` : key));
  }
  return [];
}
