"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Banner } from "@/lib/upload-post";
import { DestinationPicker, readStoredSelection, storeSelection } from "@/lib/publishing";

export default function AccountSelectionPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => setSelected(readStoredSelection()), []);
  const change = (ids: string[]) => {
    setSelected(ids);
    storeSelection(ids);
  };

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        Choose the authorized publishing destinations for a new publication. <strong>Ready</strong> means the account and its Upload-Post connection can publish right now; otherwise the reason is shown. Each selected destination becomes its own publication with its own caption and its own approval — the same post is not sent to several pages unchanged.
      </p>
      <Banner tone="info">Daily usage counts the publications already scheduled, in flight or published today (organization timezone) against the per-destination daily cap from Publishing Settings.</Banner>
      <DestinationPicker selected={selected} onChange={change} />
      <div className="mt-4 flex items-center gap-3">
        <button disabled={selected.length === 0} onClick={() => router.push("/publishing/new")} className="rounded bg-accent px-3 py-2 text-sm font-medium text-background disabled:opacity-40">
          Create publications for {selected.length} destination{selected.length === 1 ? "" : "s"}
        </button>
        {selected.length > 0 && <button onClick={() => change([])} className="text-sm text-muted hover:text-foreground">Clear selection</button>}
      </div>
    </div>
  );
}
