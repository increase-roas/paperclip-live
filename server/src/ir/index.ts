export { errorRoutes, isClientErrorPost } from "./error-routes.js";
export { gatewayProxyRoutes, type GatewayProxyOptions } from "./gateway-proxy.js";
export {
  salesDashboardProxyRoutes,
  type SalesDashboardProxyOptions,
} from "./sales-dashboard-proxy.js";
export {
  readWavvSummary,
  type WavvClientOptions,
  type WavvSetterStats,
  type WavvSummary,
} from "./wavv-client.js";
export {
  fetchNeonAdsAccounts,
  fetchNeonAdsPipeline,
  fetchSalesCapital,
  fetchSalesSnapshots,
  readPortfolioSnapshotBundle,
  type CapitalApiPayload,
  type CapitalClientEntry,
  type CapitalMetricsPayload,
  type MergedClientMetrics,
  type NeonAdsAccountClient,
  type NeonAdsAccountsPayload,
  type NeonAdsPipelineClient,
  type NeonAdsPipelinePayload,
  type ParsedClientSnapshot,
  type PortfolioSnapshotBundle,
  type SalesDashboardClientOptions,
  type SnapshotsPayload,
} from "./sales-dashboard-client.js";
export {
  buildCeoAndReadingOrder,
  ceoBoardRoutes,
  ceoBoardService,
} from "./ceo-board.js";
