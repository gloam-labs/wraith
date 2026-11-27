/**
 * Thin CLI wrapper for `npm run graphql:persist`.
 *
 * The implementation lives in `src/graphql/persist-queries.ts` so the
 * tests that use `persistQueryFiles` can import it without breaking
 * `tsc` (`rootDir: ./src` — a test importing anything under `scripts/`
 * fails the build with TS6059). This file only re-exports it and runs
 * the CLI when invoked directly, so `npm run graphql:persist` is unchanged.
 */

export * from "../src/graphql/persist-queries";
import { main } from "../src/graphql/persist-queries";

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
