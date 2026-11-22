import type { CompanyBotDetail, CompanyBotsResponse } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/bots`;

export const botsApi = {
  list: (companyId: string) => api.get<CompanyBotsResponse>(base(companyId)),
  get: (companyId: string, botId: string) =>
    api.get<CompanyBotDetail>(`${base(companyId)}/${encodeURIComponent(botId)}`),
};
