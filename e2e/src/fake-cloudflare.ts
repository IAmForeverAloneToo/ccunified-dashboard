/**
 * A stand-in for Cloudflare, for the rehearsal: the parts of the REST API the
 * setup wizard uses, with D1 databases and the uploaded Worker running in
 * workerd (Cloudflare's runtime) through Miniflare, and the "custom domain"
 * served over HTTPS behind a small proxy, so the real program and a real
 * browser reach https://<subdomain>.<zone> on this machine.
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { join } from "node:path";
import { Miniflare } from "miniflare";

export interface FakeCloudflareOptions {
  /** Scratch folder for the certificate and the databases. */
  dir: string;
  /** The API token the wizard must present. */
  token: string;
  accountName: string;
  /** The account's domain, like "rehearsal.test". */
  zone: string;
  /** Hostnames that already have a DNS record (the wizard must refuse them). */
  takenHostnames?: string[];
  /** How long after a custom domain is attached its DNS record appears. */
  dnsDelayMs?: number;
}

interface Domain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  /** When public DNS starts answering for it. */
  publishedAt: number;
}

class CfError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const hexId = () => randomBytes(16).toString("hex");

const PLACEHOLDER_WORKER =
  'export default { fetch() { return new Response("no Worker uploaded yet", { status: 404 }); } };';

/** Splits multi-statement SQL the way the wizard joins it: a statement ends with ";" at the end of a line. */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export class FakeCloudflare {
  readonly accountId = hexId();
  readonly zoneId = hexId();
  /** Base URL to give the wizard as CCUNIFIED_CLOUDFLARE_API. */
  apiUrl = "";
  /** HTTP proxy that routes https://*.<zone> to the dashboard. */
  proxyUrl = "";
  /** The dashboard's (self-signed) certificate, for SSL_CERT_FILE. */
  certFile = "";
  /** Public DNS (DNS-over-HTTPS JSON), for CCUNIFIED_DOH_URL. */
  dohUrl = "";
  /** Every API call, as "METHOD /path", for the test report. */
  readonly calls: string[] = [];
  /**
   * Visits to a dashboard address before its DNS record existed. Real DNS
   * would have answered "doesn't exist", and the visitor's DNS cache could
   * keep that answer for half an hour.
   */
  earlyVisits = 0;

  readonly databases = new Map<string, string>(); // uuid -> name
  worker: { name: string; databaseId: string; compatibilityDate: string } | undefined;
  workersDev = true;
  readonly domains: Domain[] = [];

  private mf: Miniflare | undefined;
  private readonly servers: net.Server[] = [];
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: FakeCloudflareOptions) {}

  async start(): Promise<void> {
    mkdirSync(this.opts.dir, { recursive: true });
    const keyFile = join(this.opts.dir, "key.pem");
    this.certFile = join(this.opts.dir, "cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=ccunified rehearsal",
      "-addext",
      `subjectAltName=DNS:*.${this.opts.zone}`,
      "-keyout",
      keyFile,
      "-out",
      this.certFile,
    ]);

    const api = http.createServer((req, res) => void this.handleApi(req, res));
    const site = https.createServer(
      { key: readFileSync(keyFile), cert: readFileSync(this.certFile) },
      (req, res) => void this.handleSite(req, res),
    );
    const proxy = http.createServer((_req, res) => {
      res.writeHead(405).end("only CONNECT is supported");
    });
    for (const server of [api, site, proxy]) {
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      this.servers.push(server);
    }
    const sitePort = await listen(site);
    proxy.on("connect", (req, socket: net.Socket, head) => {
      const [host, port] = (req.url ?? "").split(":");
      if (port !== "443" || !host?.endsWith(`.${this.opts.zone}`)) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      if (!this.published(host)) {
        // Where a real lookup would fail with "no such host".
        this.earlyVisits++;
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      const upstream = net.connect(sitePort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      this.sockets.add(upstream);
      upstream.on("close", () => this.sockets.delete(upstream));
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });
    const apiPort = await listen(api);
    this.apiUrl = `http://127.0.0.1:${apiPort}/client/v4`;
    this.dohUrl = `http://127.0.0.1:${apiPort}/dns-query`;
    this.proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(
      this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
    await this.mf?.dispose();
  }

  // ---- The dashboard at its custom domain ----

  private async handleSite(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!this.mf || !this.worker || !this.domains.some((d) => d.hostname === host)) {
      // What a browser would see before the domain points anywhere.
      res.writeHead(530, { "content-type": "text/plain" }).end("not connected to a Worker");
      return;
    }
    try {
      const headers: [string, string][] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i] as string;
        if (name.toLowerCase() !== "cf-connecting-ip")
          headers.push([name, req.rawHeaders[i + 1] as string]);
      }
      headers.push(["cf-connecting-ip", req.socket.remoteAddress ?? "127.0.0.1"]);
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : new Uint8Array(await readBody(req));
      const answer = await this.mf.dispatchFetch(`https://${host}${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
      });
      const out: Record<string, string | string[]> = {};
      answer.headers.forEach((value, key) => {
        if (
          !["set-cookie", "content-encoding", "content-length", "transfer-encoding"].includes(key)
        )
          out[key] = value;
      });
      const cookies = answer.headers.getSetCookie();
      if (cookies.length > 0) out["set-cookie"] = cookies;
      const data = Buffer.from(await answer.arrayBuffer());
      res.writeHead(answer.status, out).end(data);
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" }).end(String(e));
    }
  }

  // ---- Miniflare: D1 and the uploaded Worker ----

  private miniflareOptions(module: string, databaseId: string, compatibilityDate: string) {
    return {
      // On disk, so the database survives the Worker being replaced.
      resourcePersistencePath: join(this.opts.dir, "state"),
      workers: [
        {
          config: {
            name: this.worker?.name ?? "placeholder",
            compatibilityDate,
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm" as const, contents: module } },
            },
            env: { DB: { type: "d1" as const, id: databaseId } },
          },
        },
      ],
    };
  }

  private async database(id: string) {
    if (!this.databases.has(id)) throw new CfError(404, 7404, "The database could not be found");
    if (!this.mf) {
      this.mf = new Miniflare(this.miniflareOptions(PLACEHOLDER_WORKER, id, "2026-10-01"));
      await this.mf.ready;
    }
    if (this.worker && this.worker.databaseId !== id)
      throw new CfError(400, 7500, "the rehearsal supports one database at a time");
    return this.mf.getD1Database("DB");
  }

  private async query(databaseId: string, body: unknown) {
    const db = await this.database(databaseId);
    const b = body as {
      sql?: string;
      params?: unknown[];
      batch?: { sql: string; params?: unknown[] }[];
    };
    const statements: { sql: string; params: unknown[] }[] = b.batch
      ? b.batch.map((s) => ({ sql: s.sql, params: s.params ?? [] }))
      : b.params?.length
        ? [{ sql: b.sql ?? "", params: b.params }]
        : splitStatements(b.sql ?? "").map((sql) => ({ sql, params: [] }));
    if (statements.length === 0) throw new CfError(400, 7400, "No SQL to run");
    const prepared = statements.map((s) => db.prepare(s.sql).bind(...s.params));
    try {
      // Like D1, several statements run as one transaction.
      const results = prepared.length === 1 ? [await prepared[0]?.all()] : await db.batch(prepared);
      return results.map((r) => ({
        results: r?.results ?? [],
        success: true,
        meta: r?.meta ?? {},
      }));
    } catch (e) {
      throw new CfError(400, 7500, `D1 error: ${(e as Error).message}`);
    }
  }

  private async uploadWorker(name: string, req: http.IncomingMessage) {
    const form = await new Request("http://upload/", {
      method: "PUT",
      headers: { "content-type": req.headers["content-type"] ?? "" },
      body: new Uint8Array(await readBody(req)),
    }).formData();
    const text = async (v: FormDataEntryValue | null) =>
      v === null ? undefined : typeof v === "string" ? v : await v.text();
    const metadata = JSON.parse((await text(form.get("metadata"))) ?? "null") as {
      main_module?: string;
      compatibility_date?: string;
      bindings?: { type: string; name: string; id?: string }[];
    } | null;
    if (!metadata?.main_module) throw new CfError(400, 10021, "metadata.main_module is required");
    const module = await text(form.get(metadata.main_module));
    if (!module) throw new CfError(400, 10021, `no part named ${metadata.main_module}`);
    if (!metadata.compatibility_date)
      throw new CfError(400, 10021, "compatibility_date is required");
    const binding = metadata.bindings?.find((x) => x.type === "d1" && x.name === "DB");
    if (!binding?.id || !this.databases.has(binding.id))
      throw new CfError(400, 10021, "binding DB must name an existing D1 database");
    await this.database(binding.id);
    this.worker = { name, databaseId: binding.id, compatibilityDate: metadata.compatibility_date };
    await this.mf?.setOptions(
      this.miniflareOptions(module, binding.id, metadata.compatibility_date),
    );
    return { id: name };
  }

  private published(host: string): boolean {
    return this.domains.some((d) => d.hostname === host && Date.now() >= d.publishedAt);
  }

  /** Public DNS: the custom domains, once published, point at this computer. */
  private handleDoh(url: URL, res: http.ServerResponse) {
    const name = (url.searchParams.get("name") ?? "").replace(/\.$/, "");
    const type = url.searchParams.get("type");
    const exists = this.published(name);
    res.writeHead(200, { "content-type": "application/dns-json" }).end(
      JSON.stringify({
        Status: exists ? 0 : 3,
        Question: [{ name, type: type === "AAAA" ? 28 : 1 }],
        Answer: exists && type === "A" ? [{ name, type: 1, TTL: 300, data: "127.0.0.1" }] : [],
      }),
    );
  }

  // ---- The REST API ----

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://api");
    if (url.pathname === "/dns-query") {
      this.handleDoh(url, res);
      return;
    }
    const path = url.pathname.replace(/^\/client\/v4/, "");
    this.calls.push(`${req.method} ${path}`);
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    try {
      if (req.headers.authorization !== `Bearer ${this.opts.token}`) {
        throw new CfError(401, 10000, "Authentication error");
      }
      const { result, info } = await this.route(req, path, url.searchParams);
      send(200, {
        success: true,
        errors: [],
        messages: [],
        result,
        ...(info ? { result_info: info } : {}),
      });
    } catch (e) {
      const err = e instanceof CfError ? e : new CfError(500, 10001, String(e));
      send(err.status, {
        success: false,
        errors: [{ code: err.code, message: err.message }],
        result: null,
      });
    }
  }

  private async route(
    req: http.IncomingMessage,
    path: string,
    q: URLSearchParams,
  ): Promise<{ result: unknown; info?: unknown }> {
    const method = req.method ?? "GET";
    const json = async () => JSON.parse((await readBody(req)).toString() || "null");
    const list = (items: unknown[]) => ({
      result: items,
      info: {
        page: 1,
        per_page: 50,
        count: items.length,
        total_count: items.length,
        total_pages: 1,
      },
    });
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (method === "GET" && path === "/accounts") {
      return list([{ id: this.accountId, name: this.opts.accountName }]);
    }
    if (method === "GET" && path === "/zones") {
      return list(
        q.get("account.id") === this.accountId ? [{ id: this.zoneId, name: this.opts.zone }] : [],
      );
    }
    if (parts[0] === "zones") {
      if (parts[1] !== this.zoneId) throw new CfError(404, 7003, "Could not route to the zone");
      if (method === "GET" && parts[2] === "dns_records") {
        const name = q.get("name");
        const taken = [...(this.opts.takenHostnames ?? []), ...this.domains.map((d) => d.hostname)];
        return list(name && taken.includes(name) ? [{ id: hexId(), name, type: "CNAME" }] : []);
      }
    }
    if (parts[0] !== "accounts" || parts[1] !== this.accountId) {
      throw new CfError(404, 7003, `Could not route to ${path}`);
    }
    const rest = `/${parts.slice(2).join("/")}`;

    if (rest === "/d1/database" && method === "GET") {
      const name = q.get("name");
      return list(
        [...this.databases]
          .filter(([, n]) => !name || n === name)
          .map(([uuid, n]) => ({ uuid, name: n })),
      );
    }
    if (rest === "/d1/database" && method === "POST") {
      const { name } = (await json()) as { name: string };
      if ([...this.databases.values()].includes(name))
        throw new CfError(400, 7502, "A database with that name already exists");
      const uuid = randomUUID();
      this.databases.set(uuid, name);
      return { result: { uuid, name, created_at: new Date().toISOString() } };
    }
    if (parts[2] === "d1" && parts[3] === "database" && parts[4]) {
      if (parts[5] === "query" && method === "POST") {
        return { result: await this.query(parts[4], await json()) };
      }
      if (parts.length === 5 && method === "DELETE") {
        if (!this.databases.delete(parts[4]))
          throw new CfError(404, 7404, "The database could not be found");
        return { result: null };
      }
    }
    if (rest === "/workers/scripts" && method === "GET") {
      return list(this.worker ? [{ id: this.worker.name }] : []);
    }
    if (parts[2] === "workers" && parts[3] === "scripts" && parts[4]) {
      const name = parts[4];
      if (parts.length === 5 && method === "PUT")
        return { result: await this.uploadWorker(name, req) };
      if (parts.length === 5 && method === "DELETE") {
        if (this.worker?.name !== name) throw new CfError(404, 10007, "This Worker doesn't exist");
        this.worker = undefined;
        return { result: null };
      }
      if (parts[5] === "subdomain" && method === "POST") {
        if (this.worker?.name !== name) throw new CfError(404, 10007, "This Worker doesn't exist");
        const body = (await json()) as { enabled: boolean };
        this.workersDev = body.enabled;
        return { result: { enabled: body.enabled } };
      }
    }
    if (rest === "/workers/domains" && method === "PUT") {
      const body = (await json()) as { hostname: string; service: string; zone_id: string };
      if (body.zone_id !== this.zoneId || !body.hostname.endsWith(`.${this.opts.zone}`))
        throw new CfError(400, 100117, "Hostname is not in that zone");
      if (this.worker?.name !== body.service) throw new CfError(400, 100114, "No such Worker");
      const existing = this.domains.find((d) => d.hostname === body.hostname);
      const domain = existing ?? {
        id: hexId(),
        ...body,
        publishedAt: Date.now() + (this.opts.dnsDelayMs ?? 0),
      };
      if (!existing) this.domains.push(domain);
      return { result: domain };
    }
    if (rest === "/workers/domains" && method === "GET") {
      const service = q.get("service");
      return list(this.domains.filter((d) => !service || d.service === service));
    }
    if (parts[2] === "workers" && parts[3] === "domains" && parts[4] && method === "DELETE") {
      const i = this.domains.findIndex((d) => d.id === parts[4]);
      if (i < 0) throw new CfError(404, 100116, "No such domain");
      this.domains.splice(i, 1);
      return { result: null };
    }
    throw new CfError(404, 7003, `No route for ${method} ${path}`);
  }
}
