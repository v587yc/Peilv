import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";

const projectRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(projectRoot, "scripts", "create-distribution.ps1");

describe("create-distribution path handling", () => {
  test("ignores Windows device paths reported inside the project root", () => {
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
