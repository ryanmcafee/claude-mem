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

/** Same `preconnect` problem, for `spyOn(globalThis, 'fetch').mockImplementation`. */
export function fetchImpl(impl: FetchImpl): typeof fetch {
  return Object.assign(impl, { preconnect: globalThis.fetch.preconnect });
}

/** `fetch`'s first argument in each of the three forms it can arrive in. */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}
