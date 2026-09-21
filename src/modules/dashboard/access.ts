import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db";
import { organizationMembers, organizations } from "../../db/schema";
import { getAuth } from "../auth";
import { AppError } from "./http";

export type Actor = { id: string; name: string; email: string };
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export async function requireUser(request: Request): Promise<Actor> {
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session) throw new AppError(401, "UNAUTHENTICATED", "Please sign in.");
  return { id: session.user.id, name: session.user.name, email: session.user.email };
}

export async function organizationFor(actor: Actor, create = false) {
  const db = getDb();
  if (create) {
    await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(organizationMembers).where(eq(organizationMembers.userId, actor.id));
      if (existing) return;
      await tx.insert(organizations).values({ ownerUserId: actor.id, name: `${actor.name.trim().slice(0, 80) || "My"}'s workspace` }).onConflictDoNothing({ target: organizations.ownerUserId });
      const [owned] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, actor.id));
      if (!owned) throw new AppError(409, "WORKSPACE_CONFLICT", "Workspace could not be initialized.");
      await tx.insert(organizationMembers).values({ organizationId: owned.id, userId: actor.id, role: "owner" }).onConflictDoNothing();
    });
  }
  const [entry] = await db.select({ organization: organizations, role: organizationMembers.role }).from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId)).where(eq(organizationMembers.userId, actor.id));
  if (!entry) throw new AppError(404, "WORKSPACE_NOT_FOUND", "Open the dashboard to initialize your workspace.");
  if (entry.organization.status !== "active") throw new AppError(403, "WORKSPACE_INACTIVE", "This workspace is inactive.");
  return entry.organization;
}

export async function lockOrganization(tx: Transaction, organizationId: string, actor: Actor) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, organizationId)).for("update");
  const [member] = await tx.select().from(organizationMembers).where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, actor.id)));
  if (!org || !member || member.role !== "owner") throw new AppError(403, "FORBIDDEN", "Workspace owner access is required.");
  if (org.status !== "active") throw new AppError(403, "WORKSPACE_INACTIVE", "This workspace is inactive.");
  return org;
}
