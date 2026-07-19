import { access } from "node:fs/promises";
import path from "node:path";

export type ReadinessFileAccess = (filePath: string) => Promise<void>;

export async function isProductionBuildReady(input: {
  cwd?: string;
  accessFile?: ReadinessFileAccess;
} = {}): Promise<boolean> {
  const cwd = input.cwd ?? process.cwd();
  const accessFile = input.accessFile ?? access;
  const buildDirectory = path.join(cwd, ".next");

  try {
    await Promise.all([
      accessFile(path.join(buildDirectory, "BUILD_ID")),
      accessFile(path.join(buildDirectory, "routes-manifest.json")),
    ]);
    return true;
  } catch {
    return false;
  }
}
