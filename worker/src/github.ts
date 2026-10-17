const API = "https://api.github.com";
const RSA_ENCRYPTION = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface AppCredentials {
  clientId: string;
  privateKey: string;
}

export function pemBody(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array | number[]): number[] {
  return [tag, ...derLength(content.length), ...content];
}

export function pkcs8FromPem(pem: string): Uint8Array {
  const body = pemBody(pem);
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return body;
  const version = [0x02, 0x01, 0x00];
  return Uint8Array.from(der(0x30, [...version, ...RSA_ENCRYPTION, ...der(0x04, body)]));
}

export function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function appJwt(credentials: AppCredentials, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: credentials.clientId }))}`;
  const key = await crypto.subtle.importKey("pkcs8", pkcs8FromPem(credentials.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

export async function request<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "claude-autofix-hub",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new GitHubApiError(`${method} ${path} failed (HTTP ${response.status}): ${(await response.text().catch(() => "")).slice(0, 300)}`, response.status);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export class GitHubApp {
  readonly #credentials: AppCredentials;
  readonly #tokens = new Map<number, { token: string; expires: number }>();

  constructor(credentials: AppCredentials) {
    this.#credentials = credentials;
  }

  async installationFor(repository: string): Promise<number> {
    const installation = await request<{ id: number }>(await appJwt(this.#credentials), "GET", `/repos/${repository}/installation`);
    return installation.id;
  }

  async installations(): Promise<number[]> {
    const jwt = await appJwt(this.#credentials);
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const batch = await request<Array<{ id: number }>>(jwt, "GET", `/app/installations?per_page=100&page=${page}`);
      ids.push(...batch.map((installation) => installation.id));
      if (batch.length < 100) return ids;
    }
  }

  async repositories(installation: number): Promise<Array<{ full_name: string; default_branch: string; archived: boolean }>> {
    const repositories: Array<{ full_name: string; default_branch: string; archived: boolean }> = [];
    for (let page = 1; ; page++) {
      const batch = await this.as<{ repositories: Array<{ full_name: string; default_branch: string; archived: boolean }> }>(installation, "GET", `/installation/repositories?per_page=100&page=${page}`);
      repositories.push(...batch.repositories);
      if (batch.repositories.length < 100) return repositories;
    }
  }

  async token(installation: number): Promise<string> {
    const cached = this.#tokens.get(installation);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    const created = await request<{ token: string; expires_at: string }>(await appJwt(this.#credentials), "POST", `/app/installations/${installation}/access_tokens`);
    this.#tokens.set(installation, { token: created.token, expires: Date.parse(created.expires_at) });
    return created.token;
  }

  async repositoryToken(installation: number, repository: string): Promise<string> {
    const name = repository.split("/")[1] ?? repository;
    const created = await request<{ token: string }>(await appJwt(this.#credentials), "POST", `/app/installations/${installation}/access_tokens`, { repositories: [name] });
    return created.token;
  }

  async as<T>(installation: number, method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(await this.token(installation), method, path, body);
  }
}

export function encodeRef(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}
