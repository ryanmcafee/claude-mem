import { mock, type Mock } from 'bun:test';

/**
 * Bun's `fetch` carries a `preconnect` method, so a bare `mock(...)` is not
 * assignable to `globalThis.fetch`. Attaching the real one keeps the mock a
 * structural `typeof fetch` without asserting the difference away.
 */
type FetchImpl = (...args: Parameters<typeof fetch>) => Promise<Response>;

export type FetchMock = Mock<FetchImpl> & Pick<typeof fetch, 'preconnect'>;

export function mockFetch(impl: FetchImpl): FetchMock {
  return Object.assign(mock(impl), { preconnect: globalThis.fetch.preconnect });
}
