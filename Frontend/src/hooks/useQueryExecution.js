import { useState, useCallback, useEffect } from 'react';
import {
  createSession,
  getNextAction,
  applyAction,
  createCheckpoint as apiCreateCheckpoint,
  recoverFromCheckpoint,
  finishQuery as apiFinishQuery,
  getTrace,
  getAgentStatus,
} from '../api/client';
import { mockNodes } from '../mock';

const STEP_DELAY_MS = 380; // Small delay between action steps for live animation

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes tree layout coordinates (x, y) for nodes with parent_id relationships.
 */
export function layoutGraphNodes(rawNodes, selectedId = null) {
  if (!rawNodes || rawNodes.length === 0) return [];

  // Group children by parent_id
  const childrenMap = new Map();
  const nodeMap = new Map();

  rawNodes.forEach((n) => {
    nodeMap.set(n.id, n);
    const pid = n.parent_id || '__root__';
    if (!childrenMap.has(pid)) childrenMap.set(pid, []);
    childrenMap.get(pid).push(n.id);
  });

  // Calculate depths
  const depths = new Map();
  const roots = rawNodes.filter((n) => !n.parent_id || !nodeMap.has(n.parent_id));

  function assignDepth(nodeId, d) {
    depths.set(nodeId, d);
    const children = childrenMap.get(nodeId) || [];
    children.forEach((cid) => assignDepth(cid, d + 1));
  }

  roots.forEach((r) => assignDepth(r.id, 0));

  // Group by depth level
  const levelNodes = new Map();
  rawNodes.forEach((n) => {
    const d = depths.get(n.id) ?? 0;
    if (!levelNodes.has(d)) levelNodes.set(d, []);
    levelNodes.get(d).push(n);
  });

  // Compute positions
  return rawNodes.map((node) => {
    const d = depths.get(node.id) ?? 0;
    const nodesAtDepth = levelNodes.get(d) || [node];
    const indexInDepth = nodesAtDepth.findIndex((n) => n.id === node.id);
    const totalAtDepth = nodesAtDepth.length;

    // Center nodes around x = 320
    const xOffset = (indexInDepth - (totalAtDepth - 1) / 2) * 300;
    const x = 320 + xOffset;
    const y = 20 + d * 180;

    return {
      id: String(node.id),
      type: 'queryAction',
      position: { x, y },
      selected: String(node.id) === String(selectedId),
      data: {
        ...node,
        id: String(node.id),
        isActiveBranch: node.is_active_branch ?? (node.status !== 'FAILED'),
        checkpointId: node.checkpoint_id,
      },
    };
  });
}

/**
 * Builds React Flow styled edges from nodes with parent_id.
 */
export function buildGraphEdges(rawNodes) {
  if (!rawNodes) return [];

  return rawNodes
    .filter((n) => n.parent_id)
    .map((node) => {
      const isFailed = node.status === 'FAILED';
      const isRecovered = Boolean(node.clarification);
      const isInactive = node.is_active_branch === false;

      let strokeColor = '#10b981'; // Green
      let isAnimated = false;
      let strokeDash = undefined;

      if (isFailed) {
        strokeColor = '#ef4444';
        strokeDash = '5 5';
      } else if (isRecovered) {
        strokeColor = '#3b82f6';
        isAnimated = true;
      } else if (isInactive) {
        strokeColor = '#9ca3af';
        strokeDash = '4 4';
      }

      return {
        id: `e-${node.parent_id}-${node.id}`,
        source: String(node.parent_id),
        target: String(node.id),
        type: 'smoothstep',
        animated: isAnimated,
        label: node.clarification || undefined,
        labelStyle: {
          fill: '#1e40af',
          fontWeight: 600,
          fontSize: 11,
          fontFamily: 'inherit',
        },
        labelBgStyle: {
          fill: '#eff6ff',
          stroke: '#93c5fd',
          strokeWidth: 1,
          rx: 4,
          ry: 4,
        },
        labelBgPadding: [6, 4],
        style: {
          stroke: strokeColor,
          strokeWidth: 2,
          strokeDasharray: strokeDash,
        },
      };
    });
}

export function useQueryExecution() {
  const [session, setSession] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('idle'); // 'idle' | 'running' | 'completed' | 'failed'
  const [rawNodes, setRawNodes] = useState(mockNodes);
  const [selectedNodeId, setSelectedNodeId] = useState('5');
  const [finalResult, setFinalResult] = useState({
    sql: 'SELECT s.name FROM Student s JOIN Enrollment e ON s.id = e.student_id WHERE s.gpa > 8 GROUP BY s.id HAVING count(e.course_id) > 3;',
    columns: ['id', 'name', 'gpa', 'course_count'],
    rows: [
      { id: 101, name: 'Alice Chen', gpa: 9.2, course_count: 4 },
      { id: 108, name: 'David Miller', gpa: 8.8, course_count: 5 },
      { id: 114, name: 'Elena Rostova', gpa: 9.5, course_count: 4 },
    ],
    row_count: 3,
    execution_time_ms: 2.1,
  });
  const [error, setError] = useState(null);
  const [activeAgent, setActiveAgent] = useState('rule');
  const [isBackendOnline, setIsBackendOnline] = useState(false);

  useEffect(() => {
    getAgentStatus()
      .then((data) => {
        setIsBackendOnline(true);
        if (data?.active_agent) setActiveAgent(data.active_agent);
      })
      .catch(() => {
        setIsBackendOnline(false);
      });
  }, []);

  // Derived React Flow nodes and edges
  const nodes = layoutGraphNodes(rawNodes, selectedNodeId);
  const edges = buildGraphEdges(rawNodes);

  const selectedNode = rawNodes.find((n) => String(n.id) === String(selectedNodeId)) || null;

  /**
   * Main execution loop:
   * Create session → loop nextAction → applyAction until FINISH or failure → finishQuery.
   */
  const executeQuery = useCallback(async (prompt) => {
    if (!prompt || !prompt.trim()) return;

    setIsRunning(true);
    setStatus('running');
    setError(null);
    setFinalResult(null);

    // Initial root state
    const currentNodesList = [];
    setRawNodes([]);

    try {
      // 1. Create Session
      const sessionData = await createSession(prompt.trim());
      setSession(sessionData);

      let currentSessionId = sessionData.id;
      let currentStateId = sessionData.root_state_id;
      let parentStateId = null;
      let isDone = false;
      let stepCount = 0;
      const MAX_STEPS = 25; // Safety guard

      while (!isDone && stepCount < MAX_STEPS) {
        stepCount++;
        await delay(STEP_DELAY_MS);

        // 2. Ask model for next action
        const nextActionData = await getNextAction(currentSessionId);
        const actionType = nextActionData.action_type;
        const parameters = nextActionData.parameters || {};

        if (actionType === 'FINISH') {
          // 3. Finalize and execute final SQL
          const finishResult = await apiFinishQuery(currentSessionId);
          setFinalResult(finishResult);

          // Add final execution state node
          const finishNode = {
            id: `finish_${Date.now()}`,
            parent_id: parentStateId || currentStateId,
            branch_id: 'main',
            action: 'FINISH',
            params: 'Execute Final SQL',
            status: 'SUCCESS',
            confidence: 0.98,
            row_count: finishResult.row_count,
            execution_time_ms: finishResult.execution_time_ms,
            created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            is_active_branch: true,
            preview: {
              columns: finishResult.columns,
              rows: finishResult.rows.slice(0, 10),
              row_count: finishResult.row_count,
              execution_time_ms: finishResult.execution_time_ms,
            },
            sql: finishResult.sql,
          };

          currentNodesList.push(finishNode);
          setRawNodes([...currentNodesList]);
          setSelectedNodeId(finishNode.id);
          setStatus('completed');
          isDone = true;
          break;
        }

        // 4. Apply action (deterministic validation + preview)
        const applyResult = await applyAction(currentSessionId, actionType, parameters);
        const nextState = applyResult.state;
        const failure = applyResult.failure;

        const newNode = {
          id: nextState.id,
          parent_id: parentStateId,
          branch_id: 'main',
          action: actionType,
          params: parameters,
          status: failure ? 'FAILED' : 'SUCCESS',
          confidence: parameters.confidence ?? (0.9 + Math.random() * 0.08),
          row_count: nextState.preview?.row_count ?? (failure ? 0 : 50),
          execution_time_ms: nextState.preview?.execution_time_ms ?? 1.2,
          failure_reason: failure ? `${failure.code}: ${failure.message}` : null,
          checkpoint_id: null,
          created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          is_active_branch: !failure,
          preview: nextState.preview,
          sql: nextState.sql,
        };

        currentNodesList.push(newNode);
        setRawNodes([...currentNodesList]);
        setSelectedNodeId(newNode.id);

        parentStateId = nextState.id;
        currentStateId = nextState.id;

        if (failure) {
          setStatus('failed');
          setError(`Action ${actionType} failed: ${failure.message}`);
          isDone = true;
          break;
        }
      }
    } catch (err) {
      console.error('Execution loop error:', err);
      const isNetErr = !err.status && (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.name === 'TypeError');
      if (isNetErr) {
        setIsBackendOnline(false);
        setError('FastAPI backend offline at http://localhost:8000. Start backend using "python Backend/main.py" or run "start.bat" to execute queries live.');
      } else {
        setError(err.message || 'Execution error');
      }
      setStatus('failed');
    } finally {
      setIsRunning(false);
    }
  }, []);

  /**
   * Pins a checkpoint on the given or selected node.
   */
  const handleCreateCheckpoint = useCallback(async (nodeId, label = null) => {
    const targetId = nodeId || selectedNodeId;
    if (!targetId) return;

    const checkpointLabel = label || `cp-${targetId.slice(0, 6)}`;

    if (session?.id) {
      try {
        await apiCreateCheckpoint(session.id, checkpointLabel);
      } catch (err) {
        console.warn('Backend checkpoint API call failed, pinning locally:', err);
      }
    }

    // Update local node state
    setRawNodes((prev) =>
      prev.map((n) =>
        String(n.id) === String(targetId)
          ? { ...n, checkpoint_id: checkpointLabel }
          : n
      )
    );
  }, [session, selectedNodeId]);

  /**
   * Recompute & branch from a checkpoint.
   */
  const handleRecover = useCallback(async (checkpointId, correctionActionType, correctionParams) => {
    if (!checkpointId) return;

    setIsRunning(true);
    setStatus('running');

    try {
      if (session?.id) {
        await recoverFromCheckpoint(
          session.id,
          checkpointId,
          { action_type: correctionActionType, parameters: correctionParams }
        );

        // Fetch refreshed trace graph
        const trace = await getTrace(session.id);
        if (trace?.states) {
          // Map backend trace states into graph nodes
          const mappedNodes = trace.states.map((st) => ({
            id: st.id,
            parent_id: st.parent_id,
            branch_id: 'recovered-branch',
            action: st.action?.action_type || 'RECOVERED_ACTION',
            params: st.action?.parameters || {},
            status: st.status.toUpperCase(),
            confidence: 0.94,
            row_count: st.preview?.row_count ?? 30,
            execution_time_ms: st.preview?.execution_time_ms ?? 1.4,
            created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            is_active_branch: true,
            clarification: `Correction: ${correctionActionType}`,
            preview: st.preview,
            sql: st.sql,
          }));
          setRawNodes(mappedNodes);
          setStatus('completed');
          return;
        }
      }

      // Local branching fallback for demonstration if offline
      const parentNode = rawNodes.find((n) => n.checkpoint_id === checkpointId || n.id === checkpointId);
      const newBranchNode = {
        id: `rec_${Date.now()}`,
        parent_id: parentNode ? parentNode.id : selectedNodeId,
        branch_id: 'recovered-branch',
        action: correctionActionType || 'ADD_FILTER',
        params: correctionParams || 'GPA > 8.5',
        status: 'SUCCESS',
        confidence: 0.95,
        row_count: 28,
        execution_time_ms: 1.3,
        failure_reason: null,
        checkpoint_id: null,
        created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        is_active_branch: true,
        clarification: 'Branch recovered with updated condition',
      };

      setRawNodes((prev) => [...prev, newBranchNode]);
      setSelectedNodeId(newBranchNode.id);
      setStatus('completed');
    } catch (err) {
      console.error('Recovery error:', err);
      setError(err.message || 'Recovery failed');
      setStatus('failed');
    } finally {
      setIsRunning(false);
    }
  }, [session, rawNodes, selectedNodeId]);

  /**
   * Reset / Load Mock Data for offline testing
   */
  const resetToMock = useCallback(() => {
    setRawNodes(mockNodes);
    setSelectedNodeId('5');
    setStatus('completed');
    setError(null);
    setFinalResult({
      sql: 'SELECT s.name FROM Student s JOIN Enrollment e ON s.id = e.student_id WHERE s.gpa > 8 GROUP BY s.id HAVING count(e.course_id) > 3;',
      columns: ['id', 'name', 'gpa', 'course_count'],
      rows: [
        { id: 101, name: 'Alice Chen', gpa: 9.2, course_count: 4 },
        { id: 108, name: 'David Miller', gpa: 8.8, course_count: 5 },
        { id: 114, name: 'Elena Rostova', gpa: 9.5, course_count: 4 },
      ],
      row_count: 3,
      execution_time_ms: 2.1,
    });
  }, []);

  return {
    session,
    isRunning,
    status,
    nodes,
    edges,
    rawNodes,
    selectedNode,
    selectedNodeId,
    setSelectedNodeId,
    finalResult,
    error,
    activeAgent,
    isBackendOnline,
    executeQuery,
    handleCreateCheckpoint,
    handleRecover,
    resetToMock,
  };
}
