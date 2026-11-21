import type {
  AgentReadinessAttestation,
  AgentReadinessFinding,
  AgentReadinessFixAction,
  AgentReadinessFixResult,
  AgentReadinessReport,
  AgentReadinessSubjectType,
} from "@paperclipai/shared";
import { api } from "./client";

export interface AgentReadinessAttestResult {
  attestation: AgentReadinessAttestation;
  finding: AgentReadinessFinding | null;
  report: AgentReadinessReport;
}

export interface AgentReadinessAttestInput {
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  checkId: string;
  /** Required: a manual box passes only on a note saying what was checked. */
  note: string;
}

export interface AgentReadinessFixInput {
  reportId: string | null;
  subjectType: AgentReadinessSubjectType;
  subjectId: string;
  checkId: string;
  action: AgentReadinessFixAction;
  confirm: true;
}

const base = (companyId: string) => `/companies/${companyId}/agent-readiness`;

export const agentReadinessApi = {
  get: (companyId: string) => api.get<AgentReadinessReport>(base(companyId)),
  run: (companyId: string, includeLive: boolean) =>
    api.post<AgentReadinessReport>(`${base(companyId)}/reports`, { includeLive }),
  fix: (companyId: string, input: AgentReadinessFixInput) =>
    api.post<AgentReadinessFixResult>(`${base(companyId)}/fixes`, input),
  attest: (companyId: string, input: AgentReadinessAttestInput) =>
    api.post<AgentReadinessAttestResult>(`${base(companyId)}/attestations`, input),
};
