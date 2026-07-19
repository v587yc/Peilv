import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "create-distribution.ps1");

describe("create-distribution path handling", () => {
  test("keeps the PowerShell path boundary and exclusion contract platform-neutral", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).toContain("function Get-RelativeProjectPath");
    expect(source).toContain("StartsWith($rootPrefix");
    expect(source).toContain("$excludedFileNames");
    expect(source).toContain("[IO.Path]::GetFullPath");
    expect(source).not.toContain("Invoke-Expression (Get-Command powershell");

    const relativeProjectPath = (sourcePath: string): string | null => {
      const root = path.resolve(projectRoot) + path.sep;
      const full = path.resolve(sourcePath);
      return full.startsWith(root) ? full.slice(root.length) : null;
    };
    expect(relativeProjectPath(path.join(projectRoot, "package.json"))).toBe("package.json");
    expect(relativeProjectPath(path.join(path.dirname(projectRoot), "outside.txt"))).toBeNull();
  });

  const windowsOnly = process.platform === "win32" ? test : test.skip;
  windowsOnly("ignores Windows device paths reported inside the project root", () => {
    const command = [
      `$projectRoot = '${projectRoot.replaceAll("'", "''")}'`,
      `$scriptPath = '${scriptPath.replaceAll("'", "''")}'`,
      "$ErrorActionPreference = 'Stop'",
      "$tokens = $null",
      "$errors = $null",
      "$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)",
      "$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RelativeProjectPath' }, $true)",
      "Invoke-Expression $function.Extent.Text",
      "$result = Get-RelativeProjectPath -SourcePath (Join-Path $projectRoot 'NUL')",
      "if ($null -ne $result) { throw \"Expected device path to be ignored, got: $result\" }",
    ].join("; ");

    expect(() =>
      execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
        cwd: projectRoot,
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
