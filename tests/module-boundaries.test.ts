import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve("src");
const SCAN_ROOTS = [
  path.join(SOURCE_ROOT, "features"),
  path.join(SOURCE_ROOT, "lib"),
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const APP_MODULE_PATTERN = /^(?:@\/app\/|.*src\/app\/|(?:\.\.\/)+app\/)/;
const LEGACY_ROUTE_PATTERN = /^(?:@\/app\/api\/backtest(?:\/|$)|.*src\/app\/api\/backtest(?:\/|$))/;

function findAppImports(source: string): string[] {
  const sourceFile = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports: string[] = [];

  function record(specifier: ts.Expression | undefined, prefix: string) {
    if (specifier && ts.isStringLiteralLike(specifier) && APP_MODULE_PATTERN.test(specifier.text)) {
      imports.push(`${prefix}${JSON.stringify(specifier.text)}`);
    }
  }

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, ts.isImportDeclaration(node) ? "import " : "from ");
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0], "import(");
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require") record(node.arguments[0], "require(");
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  }));
  return nested.flat();
}

describe("module boundaries", () => {
  it("detects dynamic and CommonJS App Router dependencies without matching comments or ordinary strings", () => {
    expect(findAppImports(`
      const dynamicModule = import("@/app/api/example/route");
      const attributedDynamicModule = import("@/app/example", { with: { type: "json" } });
      const commonJsModule = require("../../app/api/example/route");
    `)).toHaveLength(3);
    expect(findAppImports(`
      // import("@/app/api/commented/route")
      const documentation = 'require("../../app/api/documented/route")';
    `)).toEqual([]);
  });

  it("prevents feature and shared library modules from importing App Router", async () => {
    const files = (await Promise.all(SCAN_ROOTS.map(sourceFiles))).flat();
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = findAppImports(source);
      for (const value of imports) {
        violations.push(`${path.relative(SOURCE_ROOT, file)}: ${value}`);
      }
    }

    expect(violations).toEqual([]);
  }, 15_000);

  it("prevents admin adapters from depending on the legacy backtest route", async () => {
    const adminRoute = path.join(SOURCE_ROOT, "app", "api", "admin", "backtests", "route.ts");
    const source = await readFile(adminRoute, "utf8");
    const sourceFile = ts.createSourceFile(adminRoute, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const violations: string[] = [];
    sourceFile.forEachChild(function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) && LEGACY_ROUTE_PATTERN.test(node.moduleSpecifier.text)) {
        violations.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    });
    expect(violations).toEqual([]);
  });
});
