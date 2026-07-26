import { describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { accessIdentityForRequest, verifyAccessToken } from "../src/access";

const config = {
  issuer: "https://example.cloudflareaccess.com",
  audience: "access-audience",
};

async function token(
  overrides: {
    audience?: string;
    issuer?: string;
    expiresIn?: string;
    email?: string;
    subject?: string;
    commonName?: string;
    groups?: string[];
  } = {},
) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwt = await new SignJWT({
    type: "app",
    email: overrides.email ?? "operator@example.com",
    ...(overrides.commonName
      ? { common_name: overrides.commonName }
      : {}),
    ...(overrides.groups ? { groups: overrides.groups } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(overrides.subject ?? "access-user-id")
    .setIssuer(overrides.issuer ?? config.issuer)
    .setAudience(overrides.audience ?? config.audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m")
    .sign(privateKey);
  return { jwt, publicKey };
}

describe("Cloudflare Access JWT validation", () => {
  it("accepts a signed token with exact issuer, audience, and identity", async () => {
    const signed = await token();
    await expect(
      verifyAccessToken(signed.jwt, config, signed.publicKey),
    ).resolves.toEqual({
      actor: "operator@example.com",
      email: "operator@example.com",
      subject: "access-user-id",
    });
  });

  it("accepts a signed Access service identity with an empty subject", async () => {
    const signed = await token({
      subject: "",
      email: "",
      commonName: "machine-client.access",
    });
    await expect(
      verifyAccessToken(signed.jwt, config, signed.publicKey),
    ).resolves.toEqual({
      actor: "machine-client.access",
      subject: "service:machine-client.access",
    });
  });

  it("rejects audience, issuer, expiry, and signature mismatches", async () => {
    const wrongAudience = await token({ audience: "different" });
    const wrongIssuer = await token({
      issuer: "https://different.cloudflareaccess.com",
    });
    const expired = await token({ expiresIn: "-1m" });
    const otherKey = await generateKeyPair("RS256");

    await expect(
      verifyAccessToken(wrongAudience.jwt, config, wrongAudience.publicKey),
    ).resolves.toBeNull();
    await expect(
      verifyAccessToken(wrongIssuer.jwt, config, wrongIssuer.publicKey),
    ).resolves.toBeNull();
    await expect(
      verifyAccessToken(expired.jwt, config, expired.publicKey),
    ).resolves.toBeNull();
    const valid = await token();
    await expect(
      verifyAccessToken(valid.jwt, config, otherKey.publicKey),
    ).resolves.toBeNull();
  });

  it("fails closed for Redis-free deployments without Access configuration", async () => {
    const identity = await accessIdentityForRequest(new Request("https://example.test/_ops/job-failures"), {
      REDIS_BACKEND: "cloudflare",
      ACCESS_REQUIRED: "false",
    } as never);
    expect(identity).toBeNull();
  });

  it("enforces an operator group allowlist when configured", async () => {
    const allowed = await token({ groups: ["twenty-operators", "sre"] });
    const denied = await token({ groups: ["billing"] });
    const groupConfig = { ...config, allowedGroups: new Set(["sre"]) };
    await expect(
      verifyAccessToken(allowed.jwt, groupConfig, allowed.publicKey),
    ).resolves.toMatchObject({ groups: ["twenty-operators", "sre"] });
    await expect(
      verifyAccessToken(denied.jwt, groupConfig, denied.publicKey),
    ).resolves.toBeNull();
  });
});
