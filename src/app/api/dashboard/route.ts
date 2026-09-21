import { organizationFor, requireUser } from "@/modules/dashboard/access";
import { errorResponse, checkOrigin, json, readJson, AppError } from "@/modules/dashboard/http";
import { dashboardData, executeDashboardCommand } from "@/modules/dashboard/service";
import { dashboardCommand } from "@/modules/dashboard/validation";

export async function GET(request: Request) {
  try {
    const actor = await requireUser(request);
    const organization = await organizationFor(actor, true);
    return json(await dashboardData(actor, organization.id));
  } catch (error) { return respond(error, "dashboard_read_failed"); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const actor = await requireUser(request);
    const organization = await organizationFor(actor);
    const parsed = dashboardCommand.safeParse(await readJson(request));
    if (!parsed.success) throw new AppError(400, "INVALID_REQUEST", "Check the submitted fields and try again.");
    return json(await executeDashboardCommand(actor, organization.id, parsed.data));
  } catch (error) { return respond(error, "dashboard_write_failed"); }
}

function respond(error: unknown, event: string) {
  if (!(error instanceof AppError)) console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : "UnknownError" }));
  return errorResponse(error);
}
