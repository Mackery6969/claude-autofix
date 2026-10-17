import { base64Url } from "./github.ts";

export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const HUB_AUDIENCE = "claude-autofix-hub";

export interface ActionsClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  repository: string;
  job_workflow_ref: string;
  event_name: string;
  actor: string;
}

export interface SigningKey {
  kty: string;
  n: string;
  e: string;
  kid?: string;
}

export class TokenError extends Error {}

export type KeyFetcher = () => Promise<SigningKey[]>;

export const fetchActionsKeys: KeyFetcher = async () => {
  const response = await fetch(`${ACTIONS_ISSUER}/.well-known/jwks`);
  if (!response.ok) throw new TokenError(`Couldn't fetch GitHub Actions' signing keys (HTTP ${response.status}).`);
  return ((await response.json()) as { keys: SigningKey[] }).keys;
};

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decoded<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as T;
  } catch {
    throw new TokenError("That isn't a JSON web token.");
  }
}

export async function verifyActionsToken(token: string, now: number, keys: KeyFetcher = fetchActionsKeys): Promise<ActionsClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new TokenError("That isn't a JSON web token.");
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];
  const header = decoded<{ alg?: string; kid?: string }>(headerPart);
  if (header.alg !== "RS256") throw new TokenError("The token isn't signed with RS256.");
  const jwk = (await keys()).find((key) => key.kid === header.kid);
  if (!jwk) throw new TokenError("The token is signed with a key GitHub Actions doesn't list.");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(signaturePart), new TextEncoder().encode(`${headerPart}.${claimsPart}`));
  if (!valid) throw new TokenError("The token's signature doesn't match.");
  const claims = decoded<ActionsClaims>(claimsPart);
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== ACTIONS_ISSUER) throw new TokenError("The token wasn't issued by GitHub Actions.");
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(HUB_AUDIENCE)) throw new TokenError(`The token's audience isn't ${HUB_AUDIENCE}.`);
  if (claims.exp <= seconds || (claims.nbf !== undefined && claims.nbf > seconds + 60)) throw new TokenError("The token has expired.");
  return claims;
}

export async function reportKey(hubSecret: string, repository: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hubSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`report:${repository.toLowerCase()}`));
  return base64Url(new Uint8Array(signature));
}
