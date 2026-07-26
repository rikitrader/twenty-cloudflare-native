export const BACKUP_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface BackupManifest {
  schemaVersion: typeof BACKUP_MANIFEST_SCHEMA_VERSION;
  createdAt: string;
  source: {
    engine: "postgresql";
    logicalExporter: "pg_dump";
  };
  artifact: {
    key: string;
    bytes: number;
    sha256: string;
    format: "postgresql-plain-sql";
    contentType: "application/sql";
  };
  encryption: {
    atRest: "r2-provider-managed";
    inTransit: "tls";
  };
}

export function backupManifestKey(backupKey: string): string {
  return `${backupKey}.manifest.json`;
}

export function isSha256Hex(value: string | null): value is string {
  return value !== null && /^[a-f0-9]{64}$/.test(value);
}

export function checksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value) return null;
  return Array.from(new Uint8Array(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createBackupManifest(input: {
  createdAt: string;
  key: string;
  bytes: number;
  sha256: string;
}): BackupManifest {
  if (input.bytes < 1) throw new Error("backup manifest requires bytes");
  if (!isSha256Hex(input.sha256))
    throw new Error("backup manifest requires a SHA-256 digest");
  return {
    schemaVersion: BACKUP_MANIFEST_SCHEMA_VERSION,
    createdAt: input.createdAt,
    source: {
      engine: "postgresql",
      logicalExporter: "pg_dump",
    },
    artifact: {
      key: input.key,
      bytes: input.bytes,
      sha256: input.sha256,
      format: "postgresql-plain-sql",
      contentType: "application/sql",
    },
    encryption: {
      atRest: "r2-provider-managed",
      inTransit: "tls",
    },
  };
}
