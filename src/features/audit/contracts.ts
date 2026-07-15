export type AuditActorType = "admin" | "internal" | "system" | "deployment-admin";

export type AuditQuery = {
  limit: number;
  actorId?: string;
  actorType?: AuditActorType;
  action?: string;
  objectType?: string;
  objectId?: string;
  requestId?: string;
  from?: string;
  to?: string;
  before?: AuditCursor;
  after?: AuditCursor;
};

export type AuditCursor = {
  createdAt: string;
  id: number;
};

export type AuditLogRow = {
  id: number;
  actor_id: string | null;
  actor_type: string;
  action: string;
  object_type: string;
  object_id: string | null;
  request_id: string | null;
  old_value: unknown;
  new_value: unknown;
  metadata: unknown;
  created_at: string;
};

export type AuditLogDto = {
  id: number;
  actorId: string | null;
  actorType: string;
  action: string;
  objectType: string;
  objectId: string | null;
  requestId: string | null;
  oldValue: unknown;
  newValue: unknown;
  metadata: unknown;
  createdAt: string;
};

export type AuditPage = {
  items: AuditLogDto[];
  nextCursor: string | null;
  previousCursor: string | null;
};
