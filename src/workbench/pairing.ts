// What the pairing QR code carries: where Alfred is, the Cloudflare Access
// service token and a new device's token, so one scan sets the app up. The
// shape is `Pairing` in src/api/schema.ts, which the app decodes too.

import type { ZodType } from "zod";

import { PairingSchema } from "../api/schema.ts";
import type { Pairing } from "../api/schema.ts";

export interface PairingSettings {
  server: string;
  clientId: string;
  clientSecret: string;
}

const URL_VAR = "ALFRED_WORKBENCH_URL";
const ID_VAR = "CF_ACCESS_SERVICE_CLIENT_ID";
const SECRET_VAR = "CF_ACCESS_SERVICE_CLIENT_SECRET";

/** The first problem the schema finds in a value, named after the variable it came from. Never repeats the value. */
function check(name: string, schema: ZodType, value: string): void {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${name}: ${result.error.issues[0]?.message ?? "invalid"}`);
}

/**
 * The server and the Access service token from the environment. Throws, naming
 * the variable, when one is unset or does not fit the pairing; callers read this
 * before they create a device, so a mistake leaves none behind.
 */
export function pairingSettings(env: Record<string, string | undefined> = process.env): PairingSettings {
  const value = (name: string) => env[name]?.trim() ?? "";
  const missing = [URL_VAR, ID_VAR, SECRET_VAR].filter((name) => !value(name));
  if (missing.length) throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`);

  // Like the links in WeChat replies, a trailing slash does not matter.
  const server = value(URL_VAR).replace(/\/+$/, "");
  const clientId = value(ID_VAR);
  const clientSecret = value(SECRET_VAR);
  check(URL_VAR, PairingSchema.shape.server, server);
  check(ID_VAR, PairingSchema.shape.access.shape.clientId, clientId);
  check(SECRET_VAR, PairingSchema.shape.access.shape.clientSecret, clientSecret);
  return { server, clientId, clientSecret };
}

/** The pairing for a new device, validated with the schema the app decodes with. */
export function buildPairing(settings: PairingSettings, device: { id: string; token: string }): Pairing {
  return PairingSchema.parse({
    version: 1,
    server: settings.server,
    access: { clientId: settings.clientId, clientSecret: settings.clientSecret },
    device: { id: device.id, token: device.token },
  });
}
