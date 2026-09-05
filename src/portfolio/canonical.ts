/** Object keys and unordered contract collections are canonicalized. Profile order is semantic. */
export function canonicalStringify(value: unknown, key = '', preserveArrayOrder = false): string {
  const preserve = preserveArrayOrder || key === 'metadata';
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalStringify(item, '', preserve));
    if (!preserve && key !== 'profile') items.sort();
    return `[${items.join(',')}]`;
  }
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => compareText(a, b)).map(([name, child]) => `${JSON.stringify(name)}:${canonicalStringify(child, name, preserve)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** FNV-1a 64 over UTF-16 code units; deterministic content identity, not a security signature. */
export function contentFingerprint(value: unknown): string {
  const content = canonicalStringify(value);
  // Two exact 32-bit limbs avoid allocating two BigInts per UTF-16 byte in browsers.
  let high = 0xcbf29ce4, low = 0x84222325;
  const byte = (value: number) => {
    low = (low ^ value) >>> 0;
    const carry = Math.floor(low * 435 / 0x1_0000_0000);
    high = (Math.imul(high, 435) + Math.imul(low, 256) + carry) >>> 0;
    low = Math.imul(low, 435) >>> 0;
  };
  for (let i = 0; i < content.length; i++) {
    const unit = content.charCodeAt(i);
    byte(unit & 255); byte(unit >>> 8);
  }
  return `fnv1a64-utf16:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}
/** Locale-independent UTF-16 order, identical in browser and Node. */
export const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const byId = <T extends { id: string }>(a: T, b: T): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
export const unique = (ids: string[]): string[] => [...new Set(ids)].sort();
export const roundedFte = (value: number): number => {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new RangeError('FTE arithmetic exceeds the finite safe numeric range');
  return Math.abs(value) > 100_000 ? Number(value.toFixed(10)) : Math.round(value * 1e10) / 1e10;
};
