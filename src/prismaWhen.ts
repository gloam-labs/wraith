/**
 * Conditional spread helper that restores TypeScript excess-property checking
 * inside Prisma `data` and `where` objects (#292).
 *
 * TypeScript does not apply excess-property checking to properties introduced
 * by a spread (`...(cond ? { settledNgn: 5000 } : {})`) when the enclosing
 * object literal also defines at least one valid property (`status`). Passing
 * the conditional branch as the direct object-literal argument to
 * `when<Prisma.NgnOrderUpdateInput>(cond, { ... })` forces the compiler to
 * check every property name and value type against `Target` at the call site,
 * while `NoInfer<Target>` + `Target = never` rejects calls that omit `<Target>`.
 */
export type ExactKeys<Target, Patch> = [Target] extends [never]
  ? never
  : Patch & Record<Exclude<keyof Patch, keyof Target>, never>;

// For TypeScript compatibility across all versions:
export type SafeNoInfer<T> = [T][T extends any ? 0 : never];

export function when<
  Target = never,
  Patch extends Partial<SafeNoInfer<Target>> = Partial<SafeNoInfer<Target>>,
>(
  condition: unknown,
  patch: ExactKeys<SafeNoInfer<Target>, Patch>,
): Partial<SafeNoInfer<Target>> {
  return condition ? patch : {};
}
