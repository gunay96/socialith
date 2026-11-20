"use client";

import { PublicationListPage } from "../list-page";

export default function QueuePage() {
  return (
    <PublicationListPage
      presetStates="QUEUED,PUBLISHING,SCHEDULED"
      sort="scheduledAt_asc"
      intro="Everything that is scheduled or in flight, soonest first. Queued = waiting for the publishing worker; Publishing = a provider request has been made (the result arrives by webhook, with polling as a fallback)."
      emptyText="The queue is empty."
    />
  );
}
