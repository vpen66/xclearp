/** Hook: manages rule groups data */

import { useState, useEffect, useCallback } from "react";
import {
  getGroups,
  updateRule as ipcUpdateRule,
  addCustomRule as ipcAddCustomRule,
  addGroup as ipcAddGroup,
  deleteGroup as ipcDeleteGroup,
  deleteRule as ipcDeleteRule,
} from "../lib/ipc";
import type { RuleGroup, CleanRule } from "../types/index";

export interface UseGroupsReturn {
  groups: RuleGroup[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateRule: (rule: CleanRule) => Promise<void>;
  addCustomRule: (rule: CleanRule) => Promise<void>;
  addGroup: (name: string, description: string, icon: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
}

export function useGroups(): UseGroupsReturn {
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getGroups();
      setGroups(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateRule = useCallback(async (rule: CleanRule) => {
    setError(null);
    try {
      await ipcUpdateRule(rule);
      await refresh();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [refresh]);

  const addCustomRule = useCallback(async (rule: CleanRule) => {
    setError(null);
    try {
      await ipcAddCustomRule(rule);
      await refresh();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [refresh]);

  const addGroup = useCallback(async (name: string, description: string, icon: string) => {
    setError(null);
    try {
      await ipcAddGroup(name, description, icon);
      await refresh();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [refresh]);

  const deleteGroup = useCallback(async (id: string) => {
    setError(null);
    try {
      await ipcDeleteGroup(id);
      await refresh();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [refresh]);

  const deleteRule = useCallback(async (id: string) => {
    setError(null);
    try {
      await ipcDeleteRule(id);
      await refresh();
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }, [refresh]);

  return {
    groups,
    loading,
    error,
    refresh,
    updateRule,
    addCustomRule,
    addGroup,
    deleteGroup,
    deleteRule,
  };
}
