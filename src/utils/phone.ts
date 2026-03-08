export interface NormalizedPhoneResult {
  raw: string;
  baseRaw: string;
  digitsOnly: string;
  e164: string | null;
  last4: string | null;
  extension: string | null;
  isValid: boolean;
}

/**
 * Remove common extension suffixes from a phone string.
 *
 * Examples handled:
 * - x123
 * - ext 123
 * - ext. 123
 * - ext123
 * - extension 123
 */
export function stripPhoneExtension(rawPhone: string): {
  baseRaw: string;
  extension: string | null;
} {
  const raw = (rawPhone || '').trim();

  // Match common extension patterns near the end of the string.
  const extensionPattern =
    /^(.*?)(?:[\s,;]+)?(?:ext\.?|extension|x)\s*[:.#-]?\s*(\d+)\s*$/i;

  const match = raw.match(extensionPattern);

  if (!match) {
    return {
      baseRaw: raw,
      extension: null,
    };
  }

  return {
    baseRaw: match[1].trim(),
    extension: match[2],
  };
}

/**
 * Normalize a phone number to canonical E.164 when possible.
 *
 * Current behavior:
 * - Accepts common US 10-digit input and normalizes to +1XXXXXXXXXX
 * - Accepts NANP 11-digit input starting with 1
 * - Accepts already-formatted E.164-like input once non-digits are removed
 * - Strips common extension suffixes before normalization
 *
 * Architecture note:
 * - Keep this function as the normalization boundary.
 * - If you later add a full phone parsing library, replace internals here
 *   without changing the rest of the MCP phone-matching flow.
 */
export function normalizePhoneToE164(rawPhone: string): NormalizedPhoneResult {
  const raw = (rawPhone || '').trim();
  const { baseRaw, extension } = stripPhoneExtension(raw);
  const digitsOnly = baseRaw.replace(/\D/g, '');

  let e164: string | null = null;

  if (digitsOnly.length === 10) {
    e164 = `+1${digitsOnly}`;
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    e164 = `+${digitsOnly}`;
  } else if (baseRaw.startsWith('+') && digitsOnly.length > 0) {
    e164 = `+${digitsOnly}`;
  }

  return {
    raw,
    baseRaw,
    digitsOnly,
    e164,
    last4: digitsOnly.length >= 4 ? digitsOnly.slice(-4) : null,
    extension,
    isValid: e164 !== null,
  };
}

export function buildPhoneCandidateSearch(rawPhone: string): { last4: string | null } {
  const normalized = normalizePhoneToE164(rawPhone);

  return {
    last4: normalized.last4,
  };
}

export function isExactPhoneMatch(rawPhone: string, storedPhone?: string | null): boolean {
  if (!storedPhone) return false;

  const input = normalizePhoneToE164(rawPhone);
  const stored = normalizePhoneToE164(storedPhone);

  if (!input.e164 || !stored.e164) {
    return false;
  }

  return input.e164 === stored.e164;
}
