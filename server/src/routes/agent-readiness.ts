import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  agentReadinessFixSchema,
  runAgentReadinessReportSchema,
  upsertAgentReadinessAttestationSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { agentReadinessService, type AgentReadinessServiceOptions } from "../services/agent-readiness/service.js";

export function agentReadinessRoutes(db: Db, options: AgentReadinessServiceOptions = {}) {
  const router = Router();
  const service = agentReadinessService(db, options);

  // Company members can read the report. Running reports, applying fixes and
  // attesting a manual check are board-only because they change remote state or
  // put a person's name against a rubric answer.
  router.get("/companies/:companyId/agent-readiness", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.getOrBuild(companyId));
  });

  router.post(
    "/companies/:companyId/agent-readiness/reports",
    validate(runAgentReadinessReportSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const report = await service.runReport(companyId, {
        includeLive: req.body.includeLive === true,
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      res.status(201).json(report);
    },
  );

  router.post(
    "/companies/:companyId/agent-readiness/fixes",
    validate(agentReadinessFixSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      const result = await service.applyFix({
        companyId,
        reportId: req.body.reportId ?? null,
        subjectType: req.body.subjectType,
        subjectId: req.body.subjectId,
        checkId: req.body.checkId,
        action: req.body.action,
        confirm: req.body.confirm,
        actor,
      });
      res.json(result);
    },
  );

  router.post(
    "/companies/:companyId/agent-readiness/attestations",
    validate(upsertAgentReadinessAttestationSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const actor = getActorInfo(req);
      if (actor.actorType !== "user" || !req.actor.userId) {
        throw forbidden("Board user context required");
      }
      res.json(await service.attest({
        companyId,
        subjectType: req.body.subjectType,
        subjectId: req.body.subjectId,
        checkId: req.body.checkId,
        note: req.body.note,
        userId: req.actor.userId,
      }));
    },
  );

  return router;
}
