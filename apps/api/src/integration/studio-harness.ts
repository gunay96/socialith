import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect } from "vitest";
import { hashPassword } from "@socialith/auth";
import { prisma } from "@socialith/database";
import type { Prisma } from "@socialith/database";
import { createApp } from "../app.js";

/** Shared scaffolding for the Phase 5B integration suites: the real express app on a random port and real MySQL. */
export const enabled = Boolean(process.env.MYSQL_INTEGRATION_URL);
export const PASSWORD = "Correct-Horse-Battery-1";

let server: Server;
let base = "";

export interface Envelope<T> {
  success?: boolean;
  data: T;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export async function http<T = unknown>(method: string, path: string, opts: { cookie?: string; body?: unknown; form?: FormData } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let json = {} as Envelope<T>;
  try {
    json = JSON.parse(text) as Envelope<T>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

export type Role = "OWNER" | "ADMIN" | "EDITOR" | "VIEWER";
export interface Session {
  cookie: string;
  orgId: string;
  userId: string;
}

export async function addUser(orgId: string, role: Role, tag: string): Promise<Session> {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@${tag}.test`;
  const user = await prisma.user.create({ data: { organizationId: orgId, name: role, email, passwordHash: await hashPassword(PASSWORD), role, status: "ACTIVE" } });
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(res.status).toBe(200);
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!, orgId, userId: user.id };
}

export async function makeOrg(slugPrefix: string, role: Role = "ADMIN"): Promise<Session> {
  const org = await prisma.organization.create({ data: { name: slugPrefix, slug: `${slugPrefix}${randomUUID().slice(0, 8)}` } });
  return addUser(org.id, role, slugPrefix);
}

export const get = <T = unknown>(s: Session, path: string) => http<T>("GET", path, { cookie: s.cookie });
export const post = <T = unknown>(s: Session, path: string, body?: unknown) => http<T>("POST", path, { cookie: s.cookie, body: body ?? {} });
export const put = <T = unknown>(s: Session, path: string, body: unknown) => http<T>("PUT", path, { cookie: s.cookie, body });
export const patch = <T = unknown>(s: Session, path: string, body: unknown) => http<T>("PATCH", path, { cookie: s.cookie, body });
export const del = <T = unknown>(s: Session, path: string, body?: unknown) => http<T>("DELETE", path, { cookie: s.cookie, body: body ?? {} });
export const audit = (orgId: string, action: string) => prisma.auditLog.findMany({ where: { organizationId: orgId, action } });

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Starts the app for a suite and removes every organization whose slug starts with `slugPrefix` afterwards. */
export function useServer(slugPrefix: string) {
  beforeAll(async () => {
    if (!enabled) return;
    const app = createApp(null);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    if (!enabled) return;
    await new Promise((r) => server.close(r));
    await prisma.organization.deleteMany({ where: { slug: { startsWith: slugPrefix } } });
    await prisma.$disconnect();
  });
}

/** A page network for a test: a category with visual defaults, two pages in it, a group, a campaign. */
export async function seedNetwork(orgId: string, over: { categoryVisual?: Prisma.InputJsonObject; pageVisual?: Prisma.InputJsonObject } = {}) {
  const tag = randomUUID().slice(0, 6);
  const category = await prisma.pageCategory.create({
    data: { organizationId: orgId, name: `Cat ${tag}`, slug: `cat-${tag}`, language: "tr", contentPreferences: { visual: over.categoryVisual ?? { fonts: ["Liberation Serif"], colors: ["#ffcc00"], textPosition: "LOWER_THIRD", aspectRatio: "4:5" } } },
  });
  const page = await prisma.managedPage.create({
    data: { organizationId: orgId, name: `Page ${tag}`, slug: `page-${tag}`, categoryId: category.id, profile: over.pageVisual ? { visual: over.pageVisual } : undefined },
  });
  const other = await prisma.managedPage.create({ data: { organizationId: orgId, name: `Other ${tag}`, slug: `other-${tag}`, categoryId: category.id } });
  const group = await prisma.pageGroup.create({ data: { organizationId: orgId, name: `Group ${tag}`, slug: `group-${tag}` } });
  await prisma.pageGroupMember.create({ data: { groupId: group.id, pageId: page.id } });
  const campaign = await prisma.campaign.create({ data: { organizationId: orgId, name: `Campaign ${tag}` } });
  return { category, page, other, group, campaign };
}

export async function seedAsset(orgId: string, over: Partial<{ name: string; kind: "VIDEO" | "IMAGE" | "AUDIO"; status: "READY" | "FAILED"; width: number | null; height: number | null; durationMs: number | null; rights: "UNVERIFIED" | "CONFIRMED" | "RESTRICTED" }> = {}) {
  return prisma.mediaAsset.create({
    data: {
      organizationId: orgId,
      originalName: over.name ?? `file-${randomUUID().slice(0, 6)}.png`,
      kind: over.kind ?? "IMAGE",
      status: over.status ?? "READY",
      mimeType: (over.kind ?? "IMAGE") === "VIDEO" ? "video/mp4" : "image/png",
      sizeBytes: BigInt(1000),
      sha256: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      width: over.width === undefined ? 1080 : over.width,
      height: over.height === undefined ? 1920 : over.height,
      durationMs: over.durationMs ?? null,
      rightsStatus: over.rights ?? "UNVERIFIED",
      analyzedAt: new Date(),
    },
  });
}
