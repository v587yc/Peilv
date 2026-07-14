"use client";

import { useMemo } from "react";
import {
  deletePredictions,
  fetchAnalysisDetail,
  fetchPredictionDates,
  fetchPredictions,
  fetchRemoteText,
  loadFeishuWebhook,
  saveFeishuWebhook,
  savePredictions,
  testFeishuWebhook,
  type FetchLike,
} from "../api-client";
import { useWorkstationSettings } from "./use-workstation-settings";

type OddsWorkstationOptions<TInfo, TNotes, TAlert = never> = {
  fetcher?: FetchLike;
  settings: Parameters<typeof useWorkstationSettings<TInfo, TNotes, TAlert>>[0];
};

export function createOddsWorkstationActions(fetcher: FetchLike) {
  return {
    fetchPredictions: (dateKey: string) => fetchPredictions(fetcher, dateKey),
    fetchPredictionDates: () => fetchPredictionDates(fetcher),
    savePredictions: (dateKey: string, content: string) => savePredictions(fetcher, dateKey, content),
    deletePredictions: (dateKey: string) => deletePredictions(fetcher, dateKey),
    fetchRemoteText: (url: string) => fetchRemoteText(fetcher, url),
    fetchAnalysisDetail: (dateKey: string, matchId: string) => fetchAnalysisDetail(fetcher, dateKey, matchId),
    loadFeishuWebhook: () => loadFeishuWebhook(fetcher),
    saveFeishuWebhook: (webhook: string) => saveFeishuWebhook(fetcher, webhook),
    testFeishuWebhook: () => testFeishuWebhook(fetcher),
  };
}

export function useOddsWorkstation<TInfo, TNotes, TAlert = never>({
  fetcher = fetch,
  settings,
}: OddsWorkstationOptions<TInfo, TNotes, TAlert>) {
  const actions = useMemo(() => createOddsWorkstationActions(fetcher), [fetcher]);
  const workstationSettings = useWorkstationSettings(settings);
  return { actions, settings: workstationSettings };
}
