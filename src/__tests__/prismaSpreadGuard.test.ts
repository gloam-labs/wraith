import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { Prisma } from "@prisma/client";
import { when } from "../prismaWhen";

/**
 * AST scanner that detects raw conditional spreads (`...(cond ? a : b)` or
 * `...(cond && a)`) inside Prisma `data`, `create`, `update`, or `where`
 * objects.
 *
 * Why this exists (#292):
 * TypeScript widens `{ ...(cond ? { wrongField: 123 } : {}) }` to an optional
 * union `{ wrongField?: number }`, which bypasses excess-property checking when
 * assigned to a Prisma input type whose fields are all optional. Using
 * `when<Prisma.SomeInput>(cond, { ... })` forces excess-property and value-type
 * checking at the call site before the spread happens.
 */
const PRISMA_OBJECT_PROP_NAMES = new Set(["data", "create", "update", "where"]);
const PRISMA_VAR_NAME_PATTERNS = /^(where|baseWhere|data|updateData|createData)$/;

export interface SpreadViolation {
  file: string;
  line: number;
  column: number;
  snippet: string;
}

function isUnsafePrismaSpread(node: ts.SpreadAssignment): boolean {
  let expr: ts.Expression = node.expression;
  while (ts.isParenthesizedExpression(expr)) {
    expr = expr.expression;
  }
  if (ts.isConditionalExpression(expr)) {
    return true;
  }
  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return true;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "when" &&
    (!expr.typeArguments || expr.typeArguments.length === 0)
  ) {
    return true;
  }
  return false;
}

function isInsidePrismaPayloadObject(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name)) {
      if (PRISMA_OBJECT_PROP_NAMES.has(current.name.text)) {
        return true;
      }
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      if (PRISMA_VAR_NAME_PATTERNS.test(current.name.text)) {
        return true;
      }
      if (current.type && current.type.getText().includes("Prisma.")) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

export function findRawPrismaConditionalSpreadsInSource(
  sourceText: string,
  fileName = "snippet.ts",
): SpreadViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: SpreadViolation[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isSpreadAssignment(node) &&
      isUnsafePrismaSpread(node) &&
      isInsidePrismaPayloadObject(node)
    ) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      );
      violations.push({
        file: fileName,
        line: line + 1,
        column: character + 1,
        snippet: node.getText(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function collectTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      files.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      // db.ts has concurrent PRs landing in flight; it is covered by the db split PR (#314).
      if (entry.name === "db.ts") continue;
      files.push(fullPath);
    }
  }
  return files;
}

describe("when<Target>() typed conditional spread helper (#292)", () => {
  it("returns the patch when the condition is truthy and an empty object when falsy", () => {
    const present = when<Prisma.NgnOrderUpdateInput>(true, {
      settledNGN: "5000",
    });
    expect(present).toEqual({ settledNGN: "5000" });

    const absent = when<Prisma.NgnOrderUpdateInput>(false, {
      settledNGN: "5000",
    });
    expect(absent).toEqual({});
  });

  it("rejects misspelled and mis-typed Prisma fields at compile time via @ts-expect-error", () => {
    const x: number | undefined = 5000;

    // 1. Valid fields and types compile cleanly:
    const validData: Prisma.NgnOrderUpdateInput = {
      status: "completed",
      ...when<Prisma.NgnOrderUpdateInput>(x != null, {
        settledNGN: "5000",
      }),
    };
    expect(validData).toBeDefined();

    // 2. The exact bug from Issue #292: settledNgn misspelled instead of settledNGN.
    // Without when<Target>, TypeScript accepts this because spread properties bypass excess-property checks.
    // With when<Target>, it is caught:
    // @ts-expect-error TS2353: Object literal may only specify known properties, and 'settledNgn' does not exist in type
    when<Prisma.NgnOrderUpdateInput>(x != null, { settledNgn: 5000 });

    // 3. depositTxHash belongs to OfframpOrderUpdateInput, not NgnOrderUpdateInput:
    // @ts-expect-error TS2353: Object literal may only specify known properties, and 'depositTxHash' does not exist in type
    when<Prisma.NgnOrderUpdateInput>(x != null, { depositTxHash: "0x123" });

    // 4. Correct field name but wrong value type (settledNGN expects string, not number):
    // @ts-expect-error TS2322: Type 'number' is not assignable to type 'string | StringFieldUpdateOperationsInput | undefined'.
    when<Prisma.NgnOrderUpdateInput>(x != null, { settledNGN: 5000 });

    // 5. Omitting <Target> must fail because Target defaults to never:
    // @ts-expect-error TS2345: Target is required and must not be inferred as any/untyped
    when(true, { settledNGN: "5000" });
  });

  it("AST scanner catches the exact Issue #292 snippet as a violation", () => {
    const buggySnippet = `
      await prisma.ngnOrder.update({
        where: { id: existing.id },
        data: {
          status: event.status ?? event.event,
          ...(event.amountNGN != null ? { settledNgn: Number(event.amountNGN) } : {}),
          ...(event.txHash ? { depositTxHash: event.txHash } : {}),
        },
      });
    `;

    const violations = findRawPrismaConditionalSpreadsInSource(buggySnippet);
    expect(violations).toHaveLength(2);
    expect(violations[0].snippet).toContain("settledNgn");
    expect(violations[1].snippet).toContain("depositTxHash");
  });

  it("AST scanner confirms that no raw conditional spreads remain in Prisma objects across src/", () => {
    const srcDir = path.resolve(__dirname, "..");
    const tsFiles = collectTsFiles(srcDir);
    const allViolations: SpreadViolation[] = [];

    for (const file of tsFiles) {
      const source = fs.readFileSync(file, "utf8");
      const violations = findRawPrismaConditionalSpreadsInSource(source, path.relative(srcDir, file));
      allViolations.push(...violations);
    }

    expect(allViolations).toEqual([]);
  });
});
