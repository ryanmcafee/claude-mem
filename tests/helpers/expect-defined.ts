/**
 * `expect(x).toBeDefined()` is not a type predicate, so it leaves `x` optional
 * and every following property read is a TS18048. This narrows and still fails
 * the test with a readable message.
 */
export function expectDefined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}
