/**
 * Bot status copy shared by the roster and the bot page.
 *
 * Bots are agents, so their statuses reuse the agent vocabulary. The roster
 * also carries known gateway bots with no agent row; the server reports those
 * as `unregistered`, which reads as an error to an operator. Give the states
 * people see a sentence-case label instead of the raw database value.
 */
const BOT_STATUS_LABELS: Record<string, string> = {
  unregistered: "Not registered",
};

/** "in_review" → "In review"; `unregistered` → "Not registered". */
export function botStatusLabel(status: string): string {
  const known = BOT_STATUS_LABELS[status];
  if (known) return known;
  const words = status.replace(/_/g, " ").trim();
  if (!words) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
