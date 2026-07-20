import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const approvedFixtures = {
  "infra/deploy/peilv-control": { path: "tests/fixture-peilv-control-v3-old", sha256: "5d4e408f2e72550cb783add81a892643613aacea91596853c6bed79bb048ec95" },
  "infra/deploy/trusted-host-tcb-v3.sha256": { path: "tests/fixture-trusted-host-tcb-v3-old.sha256", sha256: "bb73c2d965c6fa8f3d62a57ed50597a493ce18da226e544f4a42790e5ae4d943" },
} as const;

type EntryFacts = { isSymlink: boolean; exists: boolean; isFile: boolean; isDirectory: boolean };

function classifyEntry({ isSymlink, exists, isFile, isDirectory }: EntryFacts) {
  if (isSymlink) return "symlink";
  if (!exists) return "absent";
  if (isFile) return "regular";
  if (isDirectory) return "directory";
  return "special";
}

function planProgressiveDirectories(required: readonly string[], initiallyPresent: readonly string[]) {
  const present = new Set(initiallyPresent);
  const created: string[] = [];
  for (const directory of required) {
    if (present.has(directory)) continue;
    const parent = directory.slice(0, directory.lastIndexOf("/")) || "/";
    if (!present.has(parent)) throw new Error(`missing parent: ${parent}`);
    present.add(directory);
    created.push(directory);
  }
  return created;
}

function expectDanglingAwareShellClassifier(source: string) {
  const pathEntryExists = source.match(/path_entry_exists\(\)\s*\{([\s\S]*?)\}/)?.[1];
  const classifyEntryBody = source.match(/classify_entry\(\)\s*\{([\s\S]*?)\n\}/)?.[1];

  expect(pathEntryExists).toBeDefined();
  expect(pathEntryExists).toMatch(/\[\[\s+-e\s+"\$1"\s+\|\|\s+-L\s+"\$1"\s+\]\]/);
  expect(classifyEntryBody).toBeDefined();
  expect(classifyEntryBody).toMatch(/if\s+!\s+path_entry_exists\s+"\$p";\s*then\s+printf\s+absent/);
  expect(classifyEntryBody).toMatch(/elif\s+\[\[\s+-L\s+"\$p"\s+\]\];\s*then\s+printf\s+symlink/);
}

describe("deploy v3 bootstrap cross-platform contracts", () => {
  it.each(Object.values(approvedFixtures))("pins approved old-byte fixture $path to exact LF-only bytes", async approved => {
    const bytes = await readFile(approved.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(approved.sha256);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it.each([
    [{ isSymlink: false, exists: false, isFile: false, isDirectory: false }, "absent"],
    [{ isSymlink: true, exists: false, isFile: false, isDirectory: false }, "symlink"],
    [{ isSymlink: true, exists: true, isFile: true, isDirectory: false }, "symlink"],
    [{ isSymlink: false, exists: true, isFile: true, isDirectory: false }, "regular"],
    [{ isSymlink: false, exists: true, isFile: false, isDirectory: true }, "directory"],
    [{ isSymlink: false, exists: true, isFile: false, isDirectory: false }, "special"],
  ] as const)("classifies platform-neutral entry facts %# as %s", (facts, expected) => {
    expect(classifyEntry(facts)).toBe(expected);
  });

  it("plans parent-before-child directory creation without pre-validating absent children", () => {
    expect(planProgressiveDirectories(
      ["/root/state", "/root/state/deploy-operations", "/root/state/deploy-results", "/root/state/tcb-forensics"],
      ["/", "/root"],
    )).toEqual([
      "/root/state",
      "/root/state/deploy-operations",
      "/root/state/deploy-results",
      "/root/state/tcb-forensics",
    ]);
  });

  it("keeps the shell classifier dangling-symlink aware and directory creation progressive", async () => {
    const source = await readFile("infra/deploy/bootstrap-deploy-v3.sh", "utf8");
    expectDanglingAwareShellClassifier(source);
    expect(source).toContain('[[ "$(classify_entry "$parent")" == directory ]]');
    expect(source).not.toContain("declare -A trusted_dirs");
    expect(source).not.toContain("parent_nlink");
  });

  it("rejects a shell classifier that treats dangling symlinks as absent by checking only -e", () => {
    const onlyRegularExistence = `path_entry_exists(){ [[ -e "$1" ]]; }
classify_entry(){
  local p="$1"
  if ! path_entry_exists "$p"; then printf absent
  elif [[ -L "$p" ]]; then printf symlink
  fi
}`;

    expect(() => expectDanglingAwareShellClassifier(onlyRegularExistence)).toThrow();
  });
});
