import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../app/lib/crypto.server";

const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("secret encryption", () => {
  it("round-trips UTF-8 data using unique authenticated ciphertexts", () => {
    const plaintext = "https://hooks.slack.com/services/secret/\u2603";
    const first = encryptSecret(plaintext, key);
    const second = encryptSecret(plaintext, key);
    expect(first).not.toBe(second);
    expect(decryptSecret(first, key)).toBe(plaintext);
    expect(decryptSecret(second, key)).toBe(plaintext);
  });

  it("rejects tampering", () => {
    const encrypted = encryptSecret("secret", key);
    const last = encrypted.at(-1);
    const tampered = `${encrypted.slice(0, -1)}${last === "A" ? "B" : "A"}`;
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
});
