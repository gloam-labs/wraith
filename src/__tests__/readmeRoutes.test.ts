import { readFileSync } from "fs";
import path from "path";
import { buildOpenApiDocument } from "../openapi/build";

/**
 * The README is the first place a caller looks for a route. It had fallen
 * behind the spec: `/search` and `/host-fn` were absent, and several routes
 * existed only as a row in the JSON:API table with no parameters or example.
 *
 * This keeps it honest in one direction only, deliberately: every public path
 * the generated spec serves must be mentioned in README.md. It does not check
 * the prose, parameters or examples — that is review's job — and it skips
 * `x-internal` routes, which are not part of the public data API.
 *
 * A route documented in the README but absent from the spec is not a failure
 * here; `openapiCoverage.test.ts` owns that direction for registered routes.
 */

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Match a spec path in the README, accepting either parameter style:
 * `/accounts/{address}/balance` is written `/accounts/:address/balance` in the
 * README, and a new example may use an angle-bracket placeholder instead.
 */
function mentionsPath(readme: string, openapiPath: string): boolean {
  const escaped = openapiPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replace(
    /\\\{[^}]+\\\}/g,
    "(?::[A-Za-z0-9_]+|\\{[A-Za-z0-9_]+\\}|<[^>]+>)",
  );
  return new RegExp(pattern).test(readme);
}

describe("README route reference", () => {
  const spec = buildOpenApiDocument();
  const readme = readFileSync(path.resolve(process.cwd(), "README.md"), "utf8");

  const publicPaths = Object.entries(spec.paths)
    .filter(([, pathItem]) =>
      Object.entries(pathItem as Record<string, unknown>).some(
        ([method, operation]) =>
          HTTP_METHODS.has(method) &&
          (operation as { "x-internal"?: boolean })["x-internal"] !== true,
      ),
    )
    .map(([p]) => p)
    .sort();

  it("mentions every public path in the generated spec", () => {
    // Guards the guard: an empty or truncated spec would make the assertion
    // below pass without checking anything.
    expect(publicPaths.length).toBeGreaterThan(15);
    expect(publicPaths).toContain("/search");

    const missing = publicPaths.filter((p) => !mentionsPath(readme, p));

    expect(missing).toEqual([]);
  });

  it("does not require internal-only paths", () => {
    // A public surface must be in the README; an operator-only one need not be
    // advertised there. This asserts the filter rather than assuming it.
    const internalOnly = Object.entries(spec.paths).filter(([, pathItem]) => {
      const operations = Object.entries(pathItem as Record<string, unknown>).filter(([m]) =>
        HTTP_METHODS.has(m),
      );
      return (
        operations.length > 0 &&
        operations.every(
          ([, operation]) => (operation as { "x-internal"?: boolean })["x-internal"] === true,
        )
      );
    });
    expect(internalOnly.length).toBeGreaterThan(0);
    expect(publicPaths).not.toContain("/ops/failures");
  });
});
