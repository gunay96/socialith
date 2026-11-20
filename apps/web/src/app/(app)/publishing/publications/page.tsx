"use client";

import { PublicationListPage } from "../list-page";

export default function AllPublicationsPage() {
  return <PublicationListPage sort="updatedAt_desc" emptyText="No publications match these filters." intro="Every publication — one per content item and destination — with its current status. Open one for its full history." />;
}
