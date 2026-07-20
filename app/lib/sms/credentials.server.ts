import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret } from "../crypto.server";

export type TwilioCredentials = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

export type ShopSettings = Record<string, unknown> & {
  twilioCredentialsEnc?: string;
};

export function parseShopSettings(value: unknown): ShopSettings {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function withEncryptedTwilioCredentials(
  settings: unknown,
  credentials: TwilioCredentials | null,
  encryptionKey: string,
): Prisma.InputJsonObject {
  const next = parseShopSettings(settings);
  if (credentials) {
    next.twilioCredentialsEnc = encryptSecret(
      JSON.stringify(credentials),
      encryptionKey,
    );
  } else {
    delete next.twilioCredentialsEnc;
  }
  return next as Prisma.InputJsonObject;
}

export function decryptTwilioCredentials(
  settings: unknown,
  encryptionKey: string,
): TwilioCredentials | null {
  const encrypted = parseShopSettings(settings).twilioCredentialsEnc;
  if (typeof encrypted !== "string" || !encrypted) return null;
  const parsed = JSON.parse(
    decryptSecret(encrypted, encryptionKey),
  ) as Partial<TwilioCredentials>;
  if (!parsed.accountSid || !parsed.authToken || !parsed.fromNumber) {
    throw new Error("Stored Twilio credentials are incomplete");
  }
  return {
    accountSid: parsed.accountSid,
    authToken: parsed.authToken,
    fromNumber: parsed.fromNumber,
  };
}
