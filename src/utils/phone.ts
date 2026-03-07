export interface NormalizedPhoneResult {
  raw: string;
  e164: string | null;
  digitsOnly: string;
  digits11: string | null;
  digits10: string | null;
  isValid: boolean;
  countryAssumption: 'US';
}

export function normalizePhoneUS(rawPhone: string): NormalizedPhoneResult {
  const raw = (rawPhone || '').trim();

  // Keep digits only for normalization work
  const digitsOnly = raw.replace(/\D/g, '');

  let digits11: string | null = null;
  let digits10: string | null = null;
  let e164: string | null = null;
  let isValid = false;

  // US 10-digit number
  if (digitsOnly.length === 10) {
    digits10 = digitsOnly;
    digits11 = `1${digitsOnly}`;
    e164 = `+1${digitsOnly}`;
    isValid = true;
  }
  // US 11-digit number starting with 1
  else if (digitsOnly.length === 11 && digitsOnly.startsWith('1')) {
    digits11 = digitsOnly;
    digits10 = digitsOnly.slice(1);
    e164 = `+${digitsOnly}`;
    isValid = true;
  }
  // Already has +1 style but still handled via digits
  else {
    isValid = false;
  }

  return {
    raw,
    e164,
    digitsOnly,
    digits11,
    digits10,
    isValid,
    countryAssumption: 'US'
  };
}

export function buildPhoneSearchVariants(rawPhone: string): string[] {
  const normalized = normalizePhoneUS(rawPhone);

  if (!normalized.isValid || !normalized.digits10 || !normalized.digits11 || !normalized.e164) {
    return [];
  }

  const d10 = normalized.digits10;
  const d11 = normalized.digits11;

  const area = d10.slice(0, 3);
  const exchange = d10.slice(3, 6);
  const line = d10.slice(6, 10);

  const variants = new Set<string>([
    normalized.e164,                  // +19095995058
    d11,                              // 19095995058
    d10,                              // 9095995058
    `${area}${exchange}${line}`,      // 9095995058
    `${area}-${exchange}-${line}`,    // 909-599-5058
    `(${area}) ${exchange}-${line}`,  // (909) 599-5058
    `(${area})${exchange}-${line}`,   // (909)599-5058
    `${area}.${exchange}.${line}`,    // 909.599.5058
    `${area} ${exchange} ${line}`,    // 909 599 5058
    `1-${area}-${exchange}-${line}`,  // 1-909-599-5058
    `+1 ${area} ${exchange} ${line}`, // +1 909 599 5058
    `+1-${area}-${exchange}-${line}`  // +1-909-599-5058
  ]);

  return Array.from(variants);
}
