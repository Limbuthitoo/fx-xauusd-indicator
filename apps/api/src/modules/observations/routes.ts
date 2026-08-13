import type { FastifyInstance } from "fastify";
import { requirePermission, requireTenantModule } from "../auth/routes.js";
import { buildProductionObservationReport, refreshProductionSignalObservations } from "./service.js";

export async function observationRoutes(app: FastifyInstance) {
  app.get("/api/analytics/production-observation", async (request) => {
    const search = request.query as { moduleCode?: string; days?: string };
    const moduleCode = search.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    if (!session.tenantId) throw Object.assign(new Error("Tenant account required."), { statusCode: 403 });
    return buildProductionObservationReport({ tenantId: session.tenantId, moduleCode, days: Number(search.days ?? 7) });
  });

  app.post("/api/analytics/production-observation/refresh", async (request) => {
    const body = (request.body ?? {}) as { moduleCode?: string; days?: number };
    const moduleCode = body.moduleCode ?? "orb_max_options";
    const session = await requireTenantModule(request, moduleCode);
    if (!session.tenantId) throw Object.assign(new Error("Tenant account required."), { statusCode: 403 });
    const refresh = await refreshProductionSignalObservations({ tenantId: session.tenantId, moduleCode, days: body.days ?? 7 });
    return { refresh, report: await buildProductionObservationReport({ tenantId: session.tenantId, moduleCode, days: body.days ?? 7 }) };
  });

  app.get("/api/platform/production-observation", async (request) => {
    const session = requirePermission(request, "platform.manage");
    if (!session.platformSuperAdmin) throw Object.assign(new Error("Platform super-admin access required."), { statusCode: 403 });
    return buildProductionObservationReport({ days: Number((request.query as { days?: string }).days ?? 7) });
  });
}
