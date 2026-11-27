import { subscribeCompanyLiveEvents } from "../../services/live-events.js";

export function observeConversationResumes<T>(companyId: string, observe: () => T) {
  const observations: T[] = [];
  const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
    const details = event.payload.details as Record<string, unknown> | undefined;
    if (event.type === "activity.logged" && details?.source === "external_conversation_resumed") {
      observations.push(observe());
    }
  });
  return { observations, unsubscribe };
}
