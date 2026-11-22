import type {
  BotRegistrationPlan,
  CompanyBotDetail,
  CompanyBotsResponse,
  CompanyGatewayBotList,
  CompanyGatewayBotSummary,
} from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/bots`;

export const botsApi = {
  list: (companyId: string) => api.get<CompanyBotsResponse>(base(companyId)),
  get: (companyId: string, botId: string) =>
    api.get<CompanyBotDetail>(`${base(companyId)}/${encodeURIComponent(botId)}`),
  /** Read-only plan for registering the company's catalog bots. */
  registration: (companyId: string) => api.get<BotRegistrationPlan>(`${base(companyId)}/registration`),
  /** Live gateway key, policy and usage. Off unless the server enables it. */
  gateway: (companyId: string) => api.get<CompanyGatewayBotList>(`${base(companyId)}/gateway`),
  gatewaySummary: (companyId: string, botId: string) =>
    api.get<CompanyGatewayBotSummary>(`${base(companyId)}/${encodeURIComponent(botId)}/gateway`),
};
