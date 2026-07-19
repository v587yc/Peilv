import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const commitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const releaseIdSchema = z.string().regex(/^r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}$/);
const migrationFileSchema = z.string().regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/);
const migrationVersionSchema = z.string().regex(/^[0-9]{4}_[a-z0-9_]+$/);
const releaseFileSchema = z.object({ path: z.string().min(1).max(500), sha256: sha256Schema }).strict();

export const migrationManifestEntrySchema = z.object({
  file: migrationFileSchema,
  version: migrationVersionSchema,
  sha256: sha256Schema,
  codeRollbackSafe: z.boolean(),
}).strict();

export const migrationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  migrations: z.array(migrationManifestEntrySchema).min(1),
}).strict().superRefine((value, context) => {
  const files = new Set<string>();
  const versions = new Set<string>();
  for (const migration of value.migrations) {
    if (files.has(migration.file)) {
      context.addIssue({ code: "custom", message: `Duplicate migration file: ${migration.file}` });
    }
    if (versions.has(migration.version)) {
      context.addIssue({ code: "custom", message: `Duplicate migration version: ${migration.version}` });
    }
    files.add(migration.file);
    versions.add(migration.version);
  }
});

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  repositoryId: z.number().int().positive(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commitSha: commitShaSchema,
  releaseId: releaseIdSchema,
  sourceRunId: z.number().int().positive(),
  sourceRunAttempt: z.number().int().positive(),
  buildId: z.string().min(1).max(200),
  archiveFile: z.string().regex(/^peilv-r[1-9][0-9]*-a[1-9][0-9]*-[0-9a-f]{12}\.tar\.gz$/),
  archiveSha256: sha256Schema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  migrations: z.array(migrationManifestEntrySchema).min(1),
  files: z.array(releaseFileSchema).min(1),
}).strict().superRefine((value, context) => {
  if (value.archiveFile !== `peilv-${value.releaseId}.tar.gz`) {
    context.addIssue({ code: "custom", message: "Archive filename does not match release ID" });
  }
  if (!value.releaseId.endsWith(value.commitSha.slice(0, 12))) {
    context.addIssue({ code: "custom", message: "Release ID does not match commit SHA" });
  }
});

export type MigrationManifest = z.infer<typeof migrationManifestSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export function parseMigrationManifest(value: unknown): MigrationManifest {
  return migrationManifestSchema.parse(value);
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  return releaseManifestSchema.parse(value);
}
