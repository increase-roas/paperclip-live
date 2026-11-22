import { useQuery } from "@tanstack/react-query";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Company-wide option lists used by routine forms and pages: agents, projects
 * (including archived, so an archived project stays selectable) and the human
 * directory. They share one cache key each, so two consumers on a page do not
 * issue two requests.
 */
export function useCompanyAgents(companyId?: string | null) {
  return useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
}

export function useCompanyProjects(companyId?: string | null) {
  return useQuery({
    queryKey: queryKeys.projects.list(companyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId!, { includeArchived: true }),
    enabled: !!companyId,
  });
}

export function useCompanyMembers(companyId?: string | null) {
  return useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });
}
