"use client";

import { PublicationListPage } from "../list-page";

export default function ScheduledPage() {
  return (
    <PublicationListPage
      presetStates="SCHEDULED"
      sort="scheduledAt_asc"
      ownerTabs
      intro="Socialith's database is the master schedule. A post is run either by Socialith's own queue or — when hand-off is enabled and it is due within the provider window — by Upload-Post's scheduler; never by both. Reschedule or cancel here and both are kept in step."
      emptyText="Nothing is scheduled."
    />
  );
}
