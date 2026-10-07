/**
 * hooks/useAgent.js
 * ---------------------------------------------------------------------------
 * Which decision agent is active (rule | ornith | laya) and switching it.
 * ---------------------------------------------------------------------------
 */

import { useEffect } from 'react';
import { useQueryStore, refreshAgent, switchAgent } from '../store/queryStore';

export function useAgent({ autoLoad = true } = {}) {
  const { agent, capabilities } = useQueryStore();

  useEffect(() => {
    if (autoLoad) refreshAgent();
  }, [autoLoad]);

  return {
    agent: agent.agent,
    model: agent.model,
    baseUrl: agent.baseUrl,
    registered: agent.registered,
    loading: agent.loading,
    online: capabilities.online !== false,
    refresh: refreshAgent,
    selectAgent: switchAgent,
  };
}
