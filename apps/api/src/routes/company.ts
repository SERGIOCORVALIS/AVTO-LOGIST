import type { FastifyInstance } from "fastify";
import { loadCompanyFromEnv, companyRequisitesMd } from "@alo/shared";
import { requireDirector } from "../auth";

export function registerCompanyRoutes(app: FastifyInstance) {
  app.get("/company", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const company = loadCompanyFromEnv();
    return {
      company,
      requisites_md: companyRequisitesMd(company),
    };
  });
}
