"use client";

import { PublicationListPage } from "../list-page";

export default function FailedPage() {
  return (
    <PublicationListPage
      presetStates="FAILED,STALE"
      sort="updatedAt_desc"
      showReason
      intro="Failed = the platform or provider refused it (permanent errors are never retried automatically). Stale = it missed its slot by more than the allowed window and was held instead of being published late — review it, then publish now or reschedule. A retry after an uncertain outcome first asks the provider what happened; nothing is blindly re-sent."
      emptyText="No failed publications."
    />
  );
}
