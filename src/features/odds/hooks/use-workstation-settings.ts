"use client";

import { useEffect, useState } from "react";
import {
  LS_ALERT_CONFIGS_KEY,
  LS_NOTES_KEY,
  LS_PINNED_IDS_KEY,
  LS_PINNED_INFO_KEY,
  LS_REFRESH_INTERVAL_KEY,
  LS_SOUND_ENABLED_KEY,
} from "../constants";
import { loadStoredValue, saveStoredValue } from "../workstation-storage";

type WorkstationSettingsOptions<TInfo, TNotes, TAlert = never> = {
  storage?: Storage;
  pinnedMatches: Set<string>;
  pinnedMatchInfo: Map<string, TInfo>;
  notes: Map<string, TNotes>;
  setPinnedMatches: (value: Set<string>) => void;
  setPinnedMatchInfo: (value: Map<string, TInfo>) => void;
  setNotes: (value: Map<string, TNotes>) => void;
  alertConfigs?: Map<string, TAlert>;
  setAlertConfigs?: (value: Map<string, TAlert>) => void;
  soundEnabled?: boolean;
  setSoundEnabled?: (value: boolean) => void;
  refreshInterval?: number;
  setRefreshInterval?: (value: number) => void;
};

export function useWorkstationSettings<TInfo, TNotes, TAlert = never>({
  storage = typeof window === "undefined" ? undefined : window.localStorage,
  pinnedMatches,
  pinnedMatchInfo,
  notes,
  setPinnedMatches,
  setPinnedMatchInfo,
  setNotes,
  alertConfigs,
  setAlertConfigs,
  soundEnabled,
  setSoundEnabled,
  refreshInterval,
  setRefreshInterval,
}: WorkstationSettingsOptions<TInfo, TNotes, TAlert>) {
  const [loaded, setLoaded] = useState(false);
  const initialSoundEnabled = useState(() => soundEnabled ?? true)[0];
  const initialRefreshInterval = useState(() => refreshInterval ?? 10)[0];

  useEffect(() => {
    if (!storage) return;
    setPinnedMatches(new Set(loadStoredValue<string[]>(storage, LS_PINNED_IDS_KEY, [])));
    setPinnedMatchInfo(new Map(loadStoredValue<[string, TInfo][]>(storage, LS_PINNED_INFO_KEY, [])));
    setNotes(new Map(loadStoredValue<[string, TNotes][]>(storage, LS_NOTES_KEY, [])));
    setAlertConfigs?.(new Map(loadStoredValue<[string, TAlert][]>(storage, LS_ALERT_CONFIGS_KEY, [])));
    setSoundEnabled?.(loadStoredValue(storage, LS_SOUND_ENABLED_KEY, initialSoundEnabled));
    setRefreshInterval?.(loadStoredValue(storage, LS_REFRESH_INTERVAL_KEY, initialRefreshInterval));
    setLoaded(true);
  }, [initialRefreshInterval, initialSoundEnabled, setAlertConfigs, setNotes, setPinnedMatchInfo, setPinnedMatches, setRefreshInterval, setSoundEnabled, storage]);

  useEffect(() => {
    if (loaded && storage) saveStoredValue(storage, LS_PINNED_IDS_KEY, [...pinnedMatches]);
  }, [loaded, pinnedMatches, storage]);
  useEffect(() => {
    if (loaded && storage) saveStoredValue(storage, LS_PINNED_INFO_KEY, [...pinnedMatchInfo]);
  }, [loaded, pinnedMatchInfo, storage]);
  useEffect(() => {
    if (loaded && storage) saveStoredValue(storage, LS_NOTES_KEY, [...notes]);
  }, [loaded, notes, storage]);
  useEffect(() => {
    if (loaded && storage && alertConfigs) saveStoredValue(storage, LS_ALERT_CONFIGS_KEY, [...alertConfigs]);
  }, [alertConfigs, loaded, storage]);
  useEffect(() => {
    if (loaded && storage && soundEnabled !== undefined) saveStoredValue(storage, LS_SOUND_ENABLED_KEY, soundEnabled);
  }, [loaded, soundEnabled, storage]);
  useEffect(() => {
    if (loaded && storage && refreshInterval !== undefined) saveStoredValue(storage, LS_REFRESH_INTERVAL_KEY, refreshInterval);
  }, [loaded, refreshInterval, storage]);

  return { loaded };
}
