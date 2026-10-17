// Removes likely secrets before anything is stored.
// Runs inside the content script, so raw secrets never reach storage.
(function (root) {
  'use strict';
  const CTX = (root.CTX = root.CTX || {});

  const RULES = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
    [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED_KEY]'],
    [/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED_KEY]'],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED_KEY]'],
    [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_KEY]'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED_JWT]'],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/gi, 'Bearer [REDACTED]'],
  ];

  // key = value pairs: only redact values that look like real secrets
  // (12+ chars, letters AND digits) so code like password = os.environ["X"] stays intact.
  const ASSIGN = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b(\s*[:=]\s*["']?)([A-Za-z0-9_\-+\/=]{12,})(["']?)/gi;

  CTX.redact = function redact(text) {
    let out = String(text || '');
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    out = out.replace(ASSIGN, (m, key, sep, val, q) =>
      /\d/.test(val) && /[A-Za-z]/.test(val) ? key + sep + '[REDACTED]' + q : m
    );
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
