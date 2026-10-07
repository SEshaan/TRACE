import { useCallback, useMemo, useState } from 'react'
import { css } from '../styled-system/css'
import '../styled-system/styles.css'
import { Button } from '@/components/ui'
import FlowTest from './flowTest'
import { useSession } from './hooks/useSession'
import { useQueryRun } from './hooks/useQueryRun'
import { useAgent } from './hooks/useAgent'
import { useSessionHistory } from './hooks/useSessionHistory'
import { toFlowEdges, toFlowNodes } from './lib/flowMapping'
import { parseFilterText } from './lib/actions'
import { setNodePosition } from './store/queryStore'
import { Bookmark, GitBranch, Play, RefreshCw, AlertCircle, CheckCircle2, Footprints, StepForward, Square } from 'lucide-react'

function App() {
  const [inputQuery, setInputQuery] = useState('Students with GPA above 8 enrolled in more than 3 courses')
  const [activeBottomTab, setActiveBottomTab] = useState('sql') // 'sql' | 'results' | 'summary'
  const [checkpointLabel, setCheckpointLabel] = useState('checkpoint')
  const [recoveryInput, setRecoveryInput] = useState('gpa > 8.5')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [actionError, setActionError] = useState(null)

  const session = useSession()
  const run = useQueryRun()
  const agent = useAgent()
  const history = useSessionHistory()

  const flowNodes = useMemo(
    () => toFlowNodes(session.nodes, { edges: session.edges, selectedId: session.selectedNodeId }),
    [session.nodes, session.edges, session.selectedNodeId],
  )
  const flowEdges = useMemo(() => toFlowEdges(session.edges), [session.edges])

  const selectedNode = flowNodes.find((n) => n.id === session.selectedNodeId)?.data ?? null
  const result = run.result
  const isRunning = run.isRunning
  const isOnline = session.isOnline
  const isCheckingBackend = session.isChecking
  const errorMessage = session.error?.message ?? run.error?.message ?? null

  const handleRun = () => {
    if (!isRunning && inputQuery.trim()) {
      run.start(inputQuery, { mode: 'auto' })
    }
  }
  const handleStep = () => {
    if (run.isPaused) run.stepOnce()
    else run.start(inputQuery, { mode: 'step' })
  }

  const handleCreateCheckpoint = (stateId) => {
    session.setCheckpoint(stateId, checkpointLabel.trim() || 'checkpoint')
  }

  const handleRecover = (node) => {
    let action
    try {
      action = parseFilterText(recoveryInput)
    } catch (err) {
      setActionError(err.message)
      return
    }

    setActionError(null)
    session.recover({ checkpointId: node.checkpoint_id, action }).then((result) => {
      if (result) setRecoveryOpen(false)
    }).catch(() => {
      // The store exposes the normalized error banner.
    })
  }

  const handleNewQuery = () => {
    setInputQuery('')
    setRecoveryOpen(false)
    run.abort()
    session.reset()
  }

  const handleRecoveryToggle = () => {
    setRecoveryOpen((open) => !open)
  }

  const handleRecoveryCancel = () => {
    setRecoveryOpen(false)
  }

  const handleRecoverySubmit = (event, node) => {
    event.preventDefault()
    handleRecover(node)
  }

  const onNodesChange = useCallback((changes) => {
    for (const change of changes) {
      if (change.type === 'position' && change.position) setNodePosition(change.id, change.position)
    }
  }, [])

  const onEdgesChange = useCallback(() => {}, [])

  const status = run.isFinished ? 'completed' : run.isFailed || run.isAborted ? 'failed' : 'ready'

  return (
    <main
      className={css({
        display: 'grid',
        gridTemplateColumns: { base: '1fr', lg: '240px minmax(0, 1fr) 300px' },
        gridTemplateRows: { base: 'auto auto auto auto', lg: '1fr 200px' },
        minH: '100vh',
        bg: 'gray.50',
        color: 'gray.900',
      })}
    >
      {/* LEFT SIDEBAR: Queries & Databases */}
      <aside
        className={css({
          gridRow: { lg: '1 / 3' },
          display: 'flex',
          flexDir: 'column',
          gap: '4',
          p: '4',
          bg: 'white',
          borderRightWidth: { lg: '1px' },
          borderBottomWidth: { base: '1px', lg: '0' },
          borderColor: 'gray.200',
        })}
      >
        <div>
          <p className={css({ fontSize: 'xs', fontWeight: 'bold', color: 'gray.400', letterSpacing: '0.05em' })}>
            TRACE
          </p>

          <h1 className={css({ fontSize: 'xl', fontWeight: 'bold' })}>
            Explorer
          </h1>
        </div>

        <input
          className={css({
            w: 'full',
            h: '9',
            px: '3',
            borderWidth: '1px',
            borderColor: 'gray.300',
            borderRadius: 'md',
            bg: 'white',
            fontSize: 'sm',
          })}
          placeholder="Search queries..."
          aria-label="Search queries"
          value={history.filter.q}
          onChange={(e) => history.setFilter({ q: e.target.value })}
        />

        <div className={css({ display: 'flex', gap: '2' })}>
          {[
            ['All', null],
            ['Success', 'completed'],
            ['Failed', 'failed'],
          ].map(([label, value]) => (
            <Button
              key={label}
              size="sm"
              variant={history.filter.status === value ? 'solid' : 'outline'}
              className={css({ flex: 1 })}
              onClick={() => history.setFilter({ status: value })}
            >
              {label}
            </Button>
          ))}
        </div>

        <Button variant="outline" onClick={handleNewQuery}>
          + New query
        </Button>

        <div
          className={css({
            display: 'grid',
            gap: '2',
            fontSize: 'sm',
          })}
        >
          <strong className={css({ color: 'gray.700', fontSize: 'xs', textTransform: 'uppercase' })}>
            Session history
          </strong>

          {history.loading && (
            <p className={css({ fontSize: 'xs', color: 'gray.500' })}>Loading sessions…</p>
          )}

          {history.unsupported && (
            <p className={css({ fontSize: 'xs', color: 'amber.700' })}>
              History unavailable — this backend build has no GET /queries endpoint.
            </p>
          )}

          {!history.loading && !history.unsupported && history.sessions.length === 0 && (
            <p className={css({ fontSize: 'xs', color: 'gray.500' })}>No stored sessions yet.</p>
          )}

          <div className={css({ display: 'grid', gap: '1' })}>
            {history.sessions.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setInputQuery(item.request ?? '')
                  session.openSession(item.id)
                }}
                className={css({
                  textAlign: 'left',
                  px: '2',
                  py: '1.5',
                  borderRadius: 'md',
                  fontSize: 'xs',
                  color: 'blue.700',
                  bg: item.id === session.session.id ? 'blue.100' : 'blue.50',
                  cursor: 'pointer',
                  border: 'none',
                  _hover: { bg: 'blue.100' },
                })}
              >
                <span className={css({ display: 'block', fontWeight: 'semibold' })}>
                  {item.request || '(untitled)'}
                </span>
                <span className={css({ color: 'gray.500', fontSize: '10px' })}>
                  {item.status} · {item.stateCount ?? 0} states
                  {item.hasFailure ? ' · has failure' : ''}
                </span>
              </button>
            ))}
          </div>

          <Button size="sm" variant="outline" onClick={history.refresh} disabled={history.loading}>
            <RefreshCw size={12} className={css({ mr: '1.5' })} />
            Refresh history
          </Button>
        </div>

        <div className={css({ mt: 'auto', display: 'flex', flexDirection: 'column', gap: '2' })}>
          <div className={css({ fontSize: 'xs', color: 'gray.500', display: 'flex', justifyContent: 'space-between' })}>
            <span>Active Agent:</span>
            <span className={css({ fontWeight: 'bold', color: 'blue.600', textTransform: 'uppercase' })}>
              {agent.agent ?? '—'}
            </span>
          </div>

          {agent.registered.length > 0 && (
            <select
              aria-label="Select decision agent"
              value={agent.agent ?? ''}
              onChange={(e) => agent.selectAgent(e.target.value)}
              disabled={agent.loading}
              className={css({
                fontSize: 'xs',
                borderWidth: '1px',
                borderColor: 'gray.300',
                borderRadius: 'md',
                px: '2',
                py: '1',
                bg: 'white',
              })}
            >
              {agent.registered.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}

          <Button variant="outline" size="sm">
            + Add database
          </Button>
        </div>
      </aside>

      {/* CENTER: Canvas and Query Bar */}
      <section
        className={css({
          minW: '0',
          display: 'grid',
          gridTemplateRows: 'auto minmax(360px, 1fr)',
          bg: 'white',
        })}
      >
        <header
          className={css({
            display: 'grid',
            gap: '3',
            p: '4',
            borderBottomWidth: '1px',
            borderColor: 'gray.200',
          })}
        >
          <div
            className={css({
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '3',
            })}
          >
            <div>
              <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Database: <strong>university.sqlite</strong> {session.session.id && `· Session: ${session.session.id.slice(0, 8)}`}
                </p>
                <span
                  className={css({
                    fontSize: '10px',
                    px: '2',
                    py: '0.5',
                    borderRadius: 'full',
                    fontWeight: '600',
                    bg: isOnline ? 'green.50' : 'amber.50',
                    color: isOnline ? 'green.700' : 'amber.800',
                    border: '1px solid',
                    borderColor: isOnline ? 'green.200' : 'amber.300',
                  })}
                >
                  {isCheckingBackend
                    ? '◌ Checking backend…'
                    : isOnline
                      ? '● Backend Online (port 8000)'
                      : '○ Backend Offline'}
                </span>
              </div>

              <h2
                className={css({
                  fontSize: 'lg',
                  fontWeight: 'semibold',
                })}
              >
                {inputQuery || 'Enter a database query'}
              </h2>
            </div>

            {/* Execution Status Badge */}
            <div className={css({ display: 'flex', alignItems: 'center', gap: '2' })}>
              {isRunning ? (
                <span
                  className={css({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '1.5',
                    px: '2.5',
                    py: '1',
                    borderRadius: 'full',
                    bg: 'blue.50',
                    color: 'blue.700',
                    fontSize: 'xs',
                    fontWeight: 'semibold',
                    border: '1px solid',
                    borderColor: 'blue.200',
                  })}
                >
                  <RefreshCw size={12} className={css({ animation: 'spin 1s linear infinite' })} />
                  Step {run.stepIndex}
                </span>
              ) : run.isPaused ? (
                <span
                  className={css({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '1.5',
                    px: '2.5',
                    py: '1',
                    borderRadius: 'full',
                    bg: 'amber.50',
                    color: 'amber.800',
                    fontSize: 'xs',
                    fontWeight: 'semibold',
                    border: '1px solid',
                    borderColor: 'amber.200',
                  })}
                >
                  <StepForward size={12} />
                  Paused · step {run.stepIndex}
                </span>
              ) : status === 'completed' ? (
                <span
                  className={css({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '1.5',
                    px: '2.5',
                    py: '1',
                    borderRadius: 'full',
                    bg: 'green.50',
                    color: 'green.700',
                    fontSize: 'xs',
                    fontWeight: 'semibold',
                    border: '1px solid',
                    borderColor: 'green.200',
                  })}
                >
                  <CheckCircle2 size={12} />
                  Completed
                </span>
              ) : status === 'failed' ? (
                <span
                  className={css({
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '1.5',
                    px: '2.5',
                    py: '1',
                    borderRadius: 'full',
                    bg: 'red.50',
                    color: 'red.700',
                    fontSize: 'xs',
                    fontWeight: 'semibold',
                    border: '1px solid',
                    borderColor: 'red.200',
                  })}
                >
                  <AlertCircle size={12} />
                  Failed
                </span>
              ) : (
                <span className={css({ fontSize: 'xs', color: 'gray.400' })}>Ready</span>
              )}
            </div>
          </div>

          {/* Prompt Input and Run Button */}
          <div className={css({ display: 'flex', gap: '3' })}>
            <input
              className={css({
                flex: '1',
                minW: '0',
                h: '10',
                px: '3',
                borderWidth: '1px',
                borderColor: 'gray.300',
                borderRadius: 'md',
                fontSize: 'sm',
                _focus: {
                  borderColor: 'blue.500',
                  outline: 'none',
                  boxShadow: '0 0 0 2px rgba(59, 130, 246, 0.2)',
                },
              })}
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRun()
              }}
              placeholder="Ask natural-language query to construct SQL graph..."
              aria-label="Query request"
              disabled={isRunning}
            />

            <Button onClick={handleRun} disabled={isRunning}>
              {isRunning ? (
                <>
                  <RefreshCw size={14} className={css({ animation: 'spin 1s linear infinite', mr: '1' })} />
                  Running
                </>
              ) : (
                <>
                  <Play size={14} className={css({ mr: '1' })} />
                  Run
                </>
              )}
            </Button>

            <Button variant="outline" onClick={handleStep} disabled={isRunning}>
              <StepForward size={14} className={css({ mr: '1' })} />
              Step
            </Button>

            <Button variant="outline" onClick={run.abort} disabled={!isRunning}>
              <Square size={14} className={css({ mr: '1' })} />
              Stop
            </Button>

            <Button
              variant="outline"
              onClick={() => run.resume()}
              disabled={!run.isPaused}
              title="Continue the paused run in auto mode"
            >
              <Footprints size={14} className={css({ mr: '1' })} />
              Resume
            </Button>
          </div>

          {errorMessage && (
            <div
              className={css({
                p: '2',
                borderRadius: 'md',
                bg: 'red.50',
                border: '1px solid',
                borderColor: 'red.200',
                color: 'red.700',
                fontSize: 'xs',
                display: 'flex',
                alignItems: 'center',
                gap: '2',
              })}
            >
              <AlertCircle size={14} />
              <span>{errorMessage}</span>
              <Button size="xs" variant="ghost" onClick={session.clearError}>
                Dismiss
              </Button>
            </div>
          )}
        </header>

        {/* REACT FLOW CANVAS */}
        <div
          className={css({
            minH: '0',
            overflow: 'hidden',
            position: 'relative',
          })}
        >
          <FlowTest
            nodes={flowNodes}
            edges={flowEdges}
            onSelectNode={(nodeData) => session.selectNode(nodeData.id)}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
          />
        </div>
      </section>

      {/* RIGHT SIDEBAR: Node Details & Inspection Drawer */}
      <aside
        className={css({
          p: '4',
          bg: 'white',
          borderLeftWidth: { lg: '1px' },
          borderColor: 'gray.200',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '3',
        })}
      >
        <p className={css({ fontSize: 'xs', fontWeight: 'bold', color: 'gray.400', letterSpacing: '0.05em' })}>
          NODE INSPECTION
        </p>

        {selectedNode ? (
          <div className={css({ display: 'grid', gap: '3' })}>
            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Action
              </p>

              <h2
                className={css({
                  fontSize: 'lg',
                  fontWeight: 'semibold',
                  color: 'gray.900',
                })}
              >
                {selectedNode.action || 'Root state (no action)'}
              </h2>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Parameters
              </p>

              <p
                className={css({
                  fontSize: 'xs',
                  fontFamily: 'monospace',
                  bg: 'gray.50',
                  p: '2',
                  borderRadius: 'md',
                  border: '1px solid',
                  borderColor: 'gray.200',
                  wordBreak: 'break-all',
                })}
              >
                {typeof selectedNode.params === 'object' && selectedNode.params !== null
                  ? JSON.stringify(selectedNode.params, null, 2)
                  : String(selectedNode.params || 'None')}
              </p>
            </div>

            <div className={css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2' })}>
              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Status
                </p>

                <p
                  className={css({
                    fontSize: 'sm',
                    fontWeight: 'semibold',
                    color: selectedNode.status === 'FAILED' ? 'red.700' : 'green.700',
                  })}
                >
                  {selectedNode.status}
                </p>
              </div>

              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Confidence
                </p>

                <p className={css({ fontSize: 'sm', fontWeight: 'semibold', color: 'blue.700' })}>
                  {selectedNode.confidence != null
                    ? `${selectedNode.confidence <= 1 ? Math.round(selectedNode.confidence * 100) : Math.round(selectedNode.confidence)}%`
                    : '—'}
                </p>
              </div>
            </div>

            <div className={css({ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2' })}>
              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Rows produced
                </p>

                <p className={css({ fontSize: 'sm', color: 'gray.800', fontWeight: 'medium' })}>
                  {selectedNode.row_count != null ? `${selectedNode.row_count} rows` : '—'}
                </p>
              </div>

              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Execution time
                </p>

                <p className={css({ fontSize: 'sm', color: 'gray.800', fontWeight: 'medium' })}>
                  {selectedNode.execution_time_ms != null ? `${selectedNode.execution_time_ms} ms` : '—'}
                </p>
              </div>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Branch / State ID
              </p>

              <p className={css({ fontSize: 'xs', color: 'gray.600', fontFamily: 'monospace' })}>
                {selectedNode.branch_id || 'main'} · {selectedNode.id}
              </p>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Checkpoint
              </p>

              <p className={css({ fontSize: 'xs', color: selectedNode.checkpoint_id ? 'amber.700' : 'gray.500', fontWeight: 'medium' })}>
                {selectedNode.checkpoint_id ? `◆ ${selectedNode.checkpoint_id}` : 'None'}
              </p>
            </div>

            {selectedNode.failure_reason && (
              <div
                className={css({
                  p: '2.5',
                  borderRadius: 'md',
                  bg: 'red.50',
                  border: '1px solid',
                  borderColor: 'red.200',
                })}
              >
                <p className={css({ fontSize: 'xs', color: 'red.700', fontWeight: 'bold' })}>
                  Failure Reason
                </p>
                <p className={css({ fontSize: 'xs', color: 'red.800', mt: '1' })}>
                  {selectedNode.failure_reason}
                </p>
              </div>
            )}

            {selectedNode.clarification && (
              <div
                className={css({
                  p: '2.5',
                  borderRadius: 'md',
                  bg: 'blue.50',
                  border: '1px solid',
                  borderColor: 'blue.200',
                })}
              >
                <p className={css({ fontSize: 'xs', color: 'blue.700', fontWeight: 'bold' })}>
                  Recovery Clarification
                </p>
                <p className={css({ fontSize: 'xs', color: 'blue.800', mt: '1' })}>
                  {selectedNode.clarification}
                </p>
              </div>
            )}

            {/* Quick Action Buttons for Step 3 & 4 */}
            <div className={css({ mt: '3', display: 'flex', flexDirection: 'column', gap: '2' })}>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleCreateCheckpoint(selectedNode.id)}
                disabled={Boolean(selectedNode.checkpoint_id) || !session.session.id}
              >
                <Bookmark size={13} className={css({ mr: '1.5' })} />
                {selectedNode.checkpoint_id ? 'Checkpoint Pinned' : 'Set Checkpoint'}
              </Button>

              {!selectedNode.checkpoint_id && (
                <input
                  value={checkpointLabel}
                  onChange={(event) => setCheckpointLabel(event.target.value)}
                  aria-label="Checkpoint label"
                  placeholder="Checkpoint label"
                  className={css({
                    h: '8',
                    px: '2',
                    borderWidth: '1px',
                    borderColor: 'gray.300',
                    borderRadius: 'md',
                    fontSize: 'xs',
                  })}
                />
              )}

              <Button
                size="sm"
                variant="outline"
                onClick={handleRecoveryToggle}
                disabled={!session.session.id || session.busy?.recover === true}
              >
                <GitBranch size={13} className={css({ mr: '1.5' })} />
                {recoveryOpen ? 'Close recovery' : 'Branch / Recompute'}
              </Button>

              {recoveryOpen && (
                <form onSubmit={(event) => handleRecoverySubmit(event, selectedNode)} className={css({ display: 'grid', gap: '2', p: '2', bg: 'blue.50', border: '1px solid', borderColor: 'blue.200', borderRadius: 'md' })}>
                  <label className={css({ fontSize: 'xs', color: 'blue.800' })} htmlFor="recovery-filter">
                    Correction filter
                  </label>
                  <input
                    id="recovery-filter"
                    value={recoveryInput}
                    onChange={(event) => setRecoveryInput(event.target.value)}
                    placeholder="gpa > 8.5"
                    className={css({ h: '8', px: '2', borderWidth: '1px', borderColor: 'gray.300', borderRadius: 'md', fontSize: 'xs' })}
                  />
                  {actionError && <p className={css({ fontSize: 'xs', color: 'red.700' })}>{actionError}</p>}
                  <div className={css({ display: 'flex', gap: '2' })}>
                    <Button size="sm" type="submit" disabled={session.busy?.recover === true}>
                      Apply correction
                    </Button>
                    <Button size="sm" type="button" variant="ghost" onClick={handleRecoveryCancel}>
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              <Button
                size="sm"
                variant="outline"
                onClick={() => session.applyAction({ action_type: 'LIMIT', parameters: { limit: 5 } })}
                disabled={!session.session.id}
                title="Apply an explicit action to the current state"
              >
                Apply LIMIT 5
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={session.forceFailure}
                disabled={!session.session.id}
                title="Apply FILTER on column CGPA, which the backend always rejects"
              >
                Trigger demo failure
              </Button>

              <Button size="sm" variant="outline" onClick={run.finish} disabled={!session.session.id}>
                Finish now
              </Button>
            </div>

            {session.previewState(selectedNode.id) && (
              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Intermediate preview ({session.previewState(selectedNode.id).rowCount ?? 0} rows)
                </p>

                <div className={css({ overflowX: 'auto', mt: '1' })}>
                  <table
                    className={css({
                      width: '100%',
                      fontSize: '10px',
                      borderCollapse: 'collapse',
                      textAlign: 'left',
                    })}
                  >
                    <thead>
                      <tr className={css({ bg: 'gray.50', borderBottom: '1px solid', borderColor: 'gray.200' })}>
                        {(session.previewState(selectedNode.id).columns ?? []).map((col) => (
                          <th key={col} className={css({ p: '1.5', fontWeight: 'bold', color: 'gray.700' })}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(session.previewState(selectedNode.id).rows ?? []).slice(0, 5).map((row, idx) => (
                        <tr key={idx} className={css({ borderBottom: '1px solid', borderColor: 'gray.100' })}>
                          {(session.previewState(selectedNode.id).columns ?? []).map((col) => (
                            <td key={col} className={css({ p: '1.5', color: 'gray.800' })}>
                              {String(row[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div>
            <h2 className={css({ fontSize: 'sm', fontWeight: 'semibold' })}>
              Select a node
            </h2>
            <p className={css({ mt: '1', fontSize: 'xs', color: 'gray.500' })}>
              Click any step in the query graph to inspect its parameters, preview rows, and recovery options.
            </p>
          </div>
        )}
      </aside>

      {/* BOTTOM PANEL: Final SQL, Results Table, Summary */}
      <section
        className={css({
          gridColumn: { lg: '2 / 4' },
          p: '4',
          bg: 'white',
          borderTopWidth: '1px',
          borderColor: 'gray.200',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        })}
      >
        <div
          className={css({
            display: 'flex',
            gap: '6',
            borderBottomWidth: '1px',
            borderColor: 'gray.200',
          })}
        >
          <button
            onClick={() => setActiveBottomTab('sql')}
            className={css({
              pb: '2',
              fontSize: 'sm',
              fontWeight: activeBottomTab === 'sql' ? 'bold' : 'normal',
              color: activeBottomTab === 'sql' ? 'blue.600' : 'gray.500',
              borderBottomWidth: activeBottomTab === 'sql' ? '2px' : '0',
              borderColor: 'blue.600',
              cursor: 'pointer',
              bg: 'transparent',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
            })}
          >
            Final SQL
          </button>

          <button
            onClick={() => setActiveBottomTab('results')}
            className={css({
              pb: '2',
              fontSize: 'sm',
              fontWeight: activeBottomTab === 'results' ? 'bold' : 'normal',
              color: activeBottomTab === 'results' ? 'blue.600' : 'gray.500',
              borderBottomWidth: activeBottomTab === 'results' ? '2px' : '0',
              borderColor: 'blue.600',
              cursor: 'pointer',
              bg: 'transparent',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
            })}
          >
            Results {result?.rowCount != null ? `(${result.rowCount})` : ''}
          </button>

          <button
            onClick={() => setActiveBottomTab('summary')}
            className={css({
              pb: '2',
              fontSize: 'sm',
              fontWeight: activeBottomTab === 'summary' ? 'bold' : 'normal',
              color: activeBottomTab === 'summary' ? 'blue.600' : 'gray.500',
              borderBottomWidth: activeBottomTab === 'summary' ? '2px' : '0',
              borderColor: 'blue.600',
              cursor: 'pointer',
              bg: 'transparent',
              borderTop: 'none',
              borderLeft: 'none',
              borderRight: 'none',
            })}
          >
            Summary
          </button>
        </div>

        <div className={css({ flex: 1, minH: 0, overflowY: 'auto', mt: '3' })}>
          {activeBottomTab === 'sql' && (
            <pre
              className={css({
                whiteSpace: 'pre-wrap',
                fontFamily: 'monospace',
                fontSize: 'xs',
                color: 'gray.800',
                bg: 'gray.50',
                p: '3',
                borderRadius: 'md',
                border: '1px solid',
                borderColor: 'gray.200',
              })}
            >
              {result?.sql || selectedNode?.sql || 'No SQL generated yet.'}
            </pre>
          )}

          {activeBottomTab === 'results' && (
            <div>
              {result?.rows && result.rows.length > 0 ? (
                <table
                  className={css({
                    width: '100%',
                    fontSize: 'xs',
                    borderCollapse: 'collapse',
                    textAlign: 'left',
                  })}
                >
                  <thead>
                    <tr className={css({ bg: 'gray.50', borderBottom: '1px solid', borderColor: 'gray.200' })}>
                      {result.columns.map((col) => (
                        <th key={col} className={css({ p: '2', fontWeight: 'bold', color: 'gray.700' })}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, idx) => (
                      <tr key={idx} className={css({ borderBottom: '1px solid', borderColor: 'gray.100' })}>
                        {result.columns.map((col) => (
                          <td key={col} className={css({ p: '2', color: 'gray.800' })}>
                            {String(row[col] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  No results produced. Run a query to view final returned records.
                </p>
              )}
            </div>
          )}

          {activeBottomTab === 'summary' && (
            <div className={css({ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '4', fontSize: 'xs' })}>
              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Total Actions</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>{session.stats.actionCount}</p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Rows Produced</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>
                  {result?.rowCount ?? session.stats.rowCount ?? 0} rows
                </p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Total Latency</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>
                  {(result?.executionTimeMs ?? session.stats.totalLatencyMs) != null
                    ? `${result?.executionTimeMs ?? session.stats.totalLatencyMs} ms`
                    : '—'}
                </p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Model Decision Adapter</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1', textTransform: 'uppercase', color: 'blue.700' })}>
                  {agent.agent ?? '—'}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
