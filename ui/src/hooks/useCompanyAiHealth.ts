import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { aiConnectionsApi } from "../api/ai-connections";
import { useCompany } from "../context/CompanyContext";
import { readAiHealthDismissal, subscribeAiHealthDismissal, writeAiHealthDismissal } from "../lib/ai-health";

export function useCompanyAiHealth() {
  const { selectedCompanyId } = useCompany();
  return useQuery({
    queryKey: ["ai-connections", selectedCompanyId ?? "", "health"],
    queryFn: () => aiConnectionsApi.health(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 60_000,
  });
}

/** Hiding of the AI account warning, shared by the bar and the top-bar pill. */
export function useAiHealthDismissal(signature: string) {
  const { selectedCompanyId } = useCompany();
  const [, setVersion] = useState(0);
  const rerender = () => setVersion((version) => version + 1);
  useEffect(() => subscribeAiHealthDismissal(rerender), []);
  const hiddenUntil = selectedCompanyId && signature ? readAiHealthDismissal(selectedCompanyId, signature) : null;
  useEffect(() => {
    if (!hiddenUntil) return;
    const timeout = window.setTimeout(rerender, hiddenUntil - Date.now());
    return () => window.clearTimeout(timeout);
  }, [hiddenUntil]);
  return {
    dismissed: hiddenUntil !== null,
    dismiss: () => {
      if (selectedCompanyId) writeAiHealthDismissal(selectedCompanyId, signature);
    },
    reopen: () => {
      if (selectedCompanyId) writeAiHealthDismissal(selectedCompanyId, null);
    },
  };
}
