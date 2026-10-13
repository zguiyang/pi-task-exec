/**
 * Best-effort credential redaction for diagnostics and error messages. This is
 * applied to logs, failure messages, and event output, never to the
 * authoritative final assistant result, whose text is the worker's real answer.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\bsk-[A-Za-z0-9_-]{12,})\b/g, "sk-***REDACTED***"],
  [/(\bghp_[A-Za-z0-9]{20,})\b/g, "ghp_***REDACTED***"],
  [/(\bgithub_pat_[A-Za-z0-9_]{20,})\b/g, "github_pat_***REDACTED***"],
  [/(\bAKIA[0-9A-Z]{16})\b/g, "AKIA***REDACTED***"],
  [/(\bxox[baprs]-[A-Za-z0-9-]{10,})\b/g, "xox*-***REDACTED***"],
  [/(\bAIza[0-9A-Za-z_-]{30,})\b/g, "AIza***REDACTED***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, "$1***REDACTED***"],
  [/((?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|token)["'\s]*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi, "$1***REDACTED***"],
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

