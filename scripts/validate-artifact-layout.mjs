#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_LAYOUT_INVALID = 20;
export const ARTIFACT_CONTENT_MISSING = 21;

function fail(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function safeLeaf(value, label) {
  if (typeof value !== "string" || value.length === 0 || value === "." || value === ".." ||
      value.includes("/") || value.includes("\\") || path.basename(value) !== value) {
    fail(`Invalid ${label}`, ARTIFACT_LAYOUT_INVALID);
  }
  return value;
}

function regularEntry(directory, name) {
  const entryPath = path.join(directory, name);
  let stat;
  try {
    stat = fs.lstatSync(entryPath);
  } catch (error) {
    if (error?.code === "ENOENT") fail("Expected artifact content is missing", ARTIFACT_CONTENT_MISSING);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Artifact content must be a regular file", ARTIFACT_LAYOUT_INVALID);
}

export function validateArtifactLayout(downloadRoot, artifactName, expectedFiles) {
  const root = path.resolve(downloadRoot);
  const name = safeLeaf(artifactName, "artifact name");
  const expected = expectedFiles.map(value => safeLeaf(value, "artifact filename"));
  if (new Set(expected).size !== expected.length || expected.length === 0) fail("Expected artifact filenames must be unique", ARTIFACT_LAYOUT_INVALID);

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") fail("Artifact download root is missing", ARTIFACT_LAYOUT_INVALID);
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("Artifact download root is invalid", ARTIFACT_LAYOUT_INVALID);

  const rootEntries = fs.readdirSync(root, { withFileTypes: true });
  if (rootEntries.length !== 1 || rootEntries[0].name !== name || !rootEntries[0].isDirectory() || rootEntries[0].isSymbolicLink()) {
    fail("Artifact directory does not exactly match the API artifact name", ARTIFACT_LAYOUT_INVALID);
  }

  const candidateDirectory = path.join(root, name);
  const resolvedCandidate = fs.realpathSync(candidateDirectory);
  if (path.dirname(resolvedCandidate) !== fs.realpathSync(root) || path.basename(resolvedCandidate) !== name) {
    fail("Artifact directory escapes the download root", ARTIFACT_LAYOUT_INVALID);
  }

  const actual = fs.readdirSync(candidateDirectory).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter(value => !actual.includes(value));
  if (missing.length > 0) fail("Expected artifact content is missing", ARTIFACT_CONTENT_MISSING);
  if (actual.length !== wanted.length || actual.some((value, index) => value !== wanted[index])) {
    fail("Artifact directory contains unexpected or duplicate content", ARTIFACT_LAYOUT_INVALID);
  }
  for (const file of wanted) regularEntry(candidateDirectory, file);
  return candidateDirectory;
}

function main() {
  const [downloadRoot, artifactName, ...expectedFiles] = process.argv.slice(2);
  validateArtifactLayout(downloadRoot, artifactName, expectedFiles);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Artifact layout validation failed");
    process.exitCode = Number.isSafeInteger(error?.exitCode) ? error.exitCode : ARTIFACT_LAYOUT_INVALID;
  }
}
