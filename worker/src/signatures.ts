export const GITHUB_SIGNATURE_HEADER = "X-Hub-Signature-256";
export const REPORT_SIGNATURE_HEADER = "X-Autofix-Signature";

function hexBytes(hex: string): Uint8Array | undefined {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const signature = hexBytes(header.slice("sha256=".length));
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, new TextEncoder().encode(body));
}
