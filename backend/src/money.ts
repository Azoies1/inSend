/**
 * Money is integer cents in CAD. There are no floating-point amounts anywhere:
 * every amount entering the system goes through `cents()`.
 */
export type Cents = number & { readonly __brand: 'Cents' };

export const CURRENCY = 'CAD' as const;
export type Currency = typeof CURRENCY;

export class InvalidAmountError extends Error {
  constructor(value: unknown) {
    super(`Amount must be a safe integer number of cents, got ${String(value)}`);
    this.name = 'InvalidAmountError';
  }
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function cents(value: number): Cents {
  if (!isCents(value)) throw new InvalidAmountError(value);
  return value;
}

/** A payable amount: integer cents, strictly positive. */
export function assertPayableAmount(value: unknown): asserts value is Cents {
  if (!isCents(value) || value <= 0) throw new InvalidAmountError(value);
}
