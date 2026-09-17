import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/native-auth";

describe("native authentication", () => {
  it("hashes and verifies passwords with the Workers-supported PBKDF2 cost", async () => {
    const password = "A secure password 2026!";
    const encoded = await hashPassword(password);

    expect(encoded.hash).toBeTruthy();
    expect(encoded.salt).toBeTruthy();
    await expect(verifyPassword(password, encoded.hash, encoded.salt)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", encoded.hash, encoded.salt)).resolves.toBe(false);
  });
});
