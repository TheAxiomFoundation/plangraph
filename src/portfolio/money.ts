/** Exact nonnegative rational half-up, returning a safe integer. */
export function halfUp(numerator: bigint, denominator: bigint): number {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('halfUp requires a nonnegative numerator and positive denominator');
  return safeInteger((2n * numerator + denominator) / (2n * denominator));
}
export function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError('Money exceeds the safe integer cents range');
  return Number(value);
}
export function addCents(...values: number[]): number { return safeInteger(values.reduce((sum, value) => sum + BigInt(value), 0n)); }
/** Preserves a fixed window total using cumulative half-up; slice only after distribution. */
export function distributeFixedTotal(totalCents: number, months: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0 || !Number.isSafeInteger(months) || months <= 0) throw new RangeError('Expected nonnegative safe integer cents and a positive month count');
  return Array.from({ length: months }, (_, k) => halfUp(BigInt(totalCents) * BigInt(k + 1), BigInt(months)) - halfUp(BigInt(totalCents) * BigInt(k), BigInt(months)));
}
/** Decimal share is parsed as a rational, never as a binary floating-point multiplier. */
export function decimalShareCents(cents: number, share: string): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(share)) throw new RangeError('Expected safe integer cents and a decimal share in [0,1]');
  const [whole, fractional = ''] = share.split('.');
  return halfUp(BigInt(cents) * BigInt(whole + fractional), 10n ** BigInt(fractional.length));
}
