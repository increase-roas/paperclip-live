import {
  extractCompanyPrefixFromPath,
  normalizeCompanyPrefix,
  toCompanyRelativePath,
} from "./company-routes";

const GLOBAL_SEGMENTS = new Set(["auth", "invite", "board-claim", "cli-auth", "docs"]);

export function isRememberableCompanyPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return true;
  const [root] = segments;
  if (GLOBAL_SEGMENTS.has(root!)) return false;
  return true;
}

function findCompanyByPrefix<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  companyPrefix: string;
}): T | null {
  const normalizedPrefix = normalizeCompanyPrefix(params.companyPrefix);
  return params.companies.find((company) => normalizeCompanyPrefix(company.issuePrefix) === normalizedPrefix) ?? null;
}

export function getRememberedPathOwnerCompanyId<T extends { id: string; issuePrefix: string }>(params: {
  companies: T[];
  pathname: string;
  fallbackCompanyId: string | null;
}): string | null {
  const routeCompanyPrefix = extractCompanyPrefixFromPath(params.pathname);
  if (!routeCompanyPrefix) {
    return params.fallbackCompanyId;
  }

  return findCompanyByPrefix({
    companies: params.companies,
    companyPrefix: routeCompanyPrefix,
  })?.id ?? null;
}

export function sanitizeRememberedPathForCompany(params: {
  path: string | null | undefined;
  companyPrefix: string;
}): string {
  const normalizedPrefix = normalizeCompanyPrefix(params.companyPrefix);
  let relativePath = params.path ? toCompanyRelativePath(params.path) : "/dashboard";
  const pathSplit = relativePath.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  const rawPathname = pathSplit?.[1] ?? relativePath;
  const suffix = `${pathSplit?.[2] ?? ""}${pathSplit?.[3] ?? ""}`;
  const rawSegments = rawPathname.split("/").filter(Boolean);
  if (rawSegments.length >= 2 && normalizeCompanyPrefix(rawSegments[0]!) === normalizedPrefix) {
    relativePath = `/${rawSegments.slice(1).join("/")}${suffix}`;
  }
  if (!isRememberableCompanyPath(relativePath)) {
    return "/dashboard";
  }

  const pathname = relativePath.split("?")[0] ?? "";
  const segments = pathname.split("/").filter(Boolean);
  const [root, entityId] = segments;
  if (root === "issues" && entityId) {
    const identifierMatch = /^([A-Za-z]+)-\d+$/.exec(entityId);
    if (
      identifierMatch &&
      normalizeCompanyPrefix(identifierMatch[1] ?? "") !== normalizedPrefix
    ) {
      return "/dashboard";
    }
  }

  return relativePath;
}
