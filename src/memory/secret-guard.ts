/**
 * Defense-in-depth only — the primary defense is that secret *files* are never indexed at
 * all (src/index/ignore.ts's isSecretPath, reused verbatim by the memory layer). This catches
 * the narrower case of a secret value getting typed or pasted into memory *content* itself
 * (e.g. a decision note that accidentally includes a real key). Deliberately a short,
 * high-confidence list — a heuristic, not a claim of exhaustive secret detection.
 */
const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id shape
  /\bsk-[A-Za-z0-9]{20,}\b/, // common "sk-..." API key shape
  /\b(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
];

export function containsLikelySecret(content: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(content));
}
