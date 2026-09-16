import { describe, expect, it } from "vitest";
import {
  backupManifestKey,
  checksumHex,
  createBackupManifest,
  isSha256Hex,
} from "../src/backup-manifest";

describe("backup integrity manifest", () => {
  const sha256 = "ab".repeat(32);

  it("binds a logical dump to its size and digest", () => {
    const manifest = createBackupManifest({
      createdAt: "2026-07-25T12:00:00.000Z",
      key: "backups/2026-07-25T1200.sql",
      bytes: 4096,
      sha256,
    });
    expect(manifest.artifact).toEqual({
      key: "backups/2026-07-25T1200.sql",
      bytes: 4096,
      sha256,
      format: "sqlite-json",
      contentType: "application/json",
    });
    expect(manifest.encryption).toEqual({
      atRest: "r2-provider-managed",
      inTransit: "tls",
    });
  });

  it("creates a colocated manifest key and validates digests", () => {
    expect(backupManifestKey("backups/a.sql")).toBe(
      "backups/a.sql.manifest.json",
    );
    expect(isSha256Hex(sha256)).toBe(true);
    expect(isSha256Hex("not-a-digest")).toBe(false);
    expect(checksumHex(new Uint8Array([0, 15, 255]).buffer)).toBe("000fff");
  });

  it("rejects incomplete provenance", () => {
    expect(() =>
      createBackupManifest({
        createdAt: "2026-07-25T12:00:00.000Z",
        key: "backups/a.sql",
        bytes: 0,
        sha256,
      }),
    ).toThrow("requires bytes");
  });
});
