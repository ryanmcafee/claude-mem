/**
 * The part of `fetch` that an injected transport actually has to provide.
 *
 * Bun's `fetch` carries a `preconnect` method, so annotating an injection point
 * as `typeof fetch` demands it from every caller-supplied transport -- and no
 * consumer in this repository ever reaches for it.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
