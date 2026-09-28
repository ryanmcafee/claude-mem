/**
 * `Response.json()` resolves to `unknown`, so every assertion against a decoded
 * body needs the shape stated somewhere. Stating it at the call site is the only
 * place a reviewer can check it against the route, which is why this single
 * unchecked conversion is contained here instead of spread across suites.
 */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
