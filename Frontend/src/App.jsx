import { useState } from 'react'
import { css } from '../styled-system/css'
import '../styled-system/styles.css'
import { Button } from '@/components/ui'
import FlowTest from './flowTest'
import { useQueryExecution } from './hooks/useQueryExecution'
import { Bookmark, GitBranch, Play, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'

function App() {
  const [inputQuery, setInputQuery] = useState('Students with GPA above 8 enrolled in more than 3 courses')
  const [activeBottomTab, setActiveBottomTab] = useState('sql') // 'sql' | 'results' | 'summary'

  const {
    session,
    isRunning,
    status,
    nodes,
    edges,
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
  } = useQueryExecution()

  const handleRun = () => {
    if (!isRunning && inputQuery.trim()) {
      executeQuery(inputQuery)
    }
  }

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
        />

        <div className={css({ display: 'flex', gap: '2' })}>
          <Button size="sm" variant="outline" className={css({ flex: 1 })}>
            All
          </Button>

          <Button size="sm" variant="outline" className={css({ flex: 1 })}>
            Success
          </Button>

          <Button size="sm" variant="outline" className={css({ flex: 1 })}>
            Failed
          </Button>
        </div>

        <Button
          variant="outline"
          onClick={() => {
            setInputQuery('')
            resetToMock()
          }}
        >
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
            □ university.sqlite
          </strong>

          <button
            onClick={() => {
              setInputQuery('Students with GPA above 8 enrolled in more than 3 courses')
              resetToMock()
            }}
            className={css({
              textAlign: 'left',
              pl: '3',
              py: '1',
              borderRadius: 'md',
              fontSize: 'xs',
              color: 'green.700',
              bg: 'green.50',
              cursor: 'pointer',
              border: 'none',
              _hover: { bg: 'green.100' },
            })}
          >
            ● GPA above 8 (active mock)
          </button>

          <button
            onClick={() => {
              const q = 'Select students where gpa > 8.5'
              setInputQuery(q)
              executeQuery(q)
            }}
            className={css({
              textAlign: 'left',
              pl: '3',
              py: '1',
              borderRadius: 'md',
              fontSize: 'xs',
              color: 'blue.700',
              bg: 'blue.50',
              cursor: 'pointer',
              border: 'none',
              _hover: { bg: 'blue.100' },
            })}
          >
            ● Live API: GPA &gt; 8.5
          </button>

          <strong className={css({ color: 'gray.700', fontSize: 'xs', textTransform: 'uppercase', mt: '2' })}>
            □ library.sqlite
          </strong>
          <strong className={css({ color: 'gray.700', fontSize: 'xs', textTransform: 'uppercase' })}>
            □ hospital.sqlite
          </strong>
        </div>

        <div className={css({ mt: 'auto', display: 'flex', flexDirection: 'column', gap: '2' })}>
          <div className={css({ fontSize: 'xs', color: 'gray.500', display: 'flex', justifyContent: 'space-between' })}>
            <span>Active Agent:</span>
            <span className={css({ fontWeight: 'bold', color: 'blue.600', textTransform: 'uppercase' })}>
              {activeAgent}
            </span>
          </div>
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
                  Database: <strong>university.sqlite</strong> {session?.id && `· Session: ${session.id.slice(0, 8)}`}
                </p>
                <span
                  className={css({
                    fontSize: '10px',
                    px: '2',
                    py: '0.5',
                    borderRadius: 'full',
                    fontWeight: '600',
                    bg: isBackendOnline ? 'green.50' : 'amber.50',
                    color: isBackendOnline ? 'green.700' : 'amber.800',
                    border: '1px solid',
                    borderColor: isBackendOnline ? 'green.200' : 'amber.300',
                  })}
                >
                  {isBackendOnline ? '● Backend Online (port 8000)' : '○ Backend Offline (demo fallback)'}
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
                  Executing Actions...
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
          </div>

          {error && (
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
              <span>{error}</span>
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
            nodes={nodes}
            edges={edges}
            onSelectNode={(nodeData) => setSelectedNodeId(nodeData.id)}
            selectedNodeId={selectedNodeId}
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
                {selectedNode.action}
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
                {typeof selectedNode.params === 'object'
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
                disabled={Boolean(selectedNode.checkpoint_id)}
              >
                <Bookmark size={13} className={css({ mr: '1.5' })} />
                {selectedNode.checkpoint_id ? 'Checkpoint Pinned' : 'Set Checkpoint'}
              </Button>

              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const newParam = prompt('Enter correction parameter (e.g. GPA > 8.5):', 'GPA > 8.5')
                  if (newParam) {
                    handleRecover(selectedNode.checkpoint_id || selectedNode.id, 'ADD_FILTER', newParam)
                  }
                }}
              >
                <GitBranch size={13} className={css({ mr: '1.5' })} />
                Branch / Recompute
              </Button>
            </div>
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
            Results {finalResult?.row_count != null ? `(${finalResult.row_count})` : ''}
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
              {finalResult?.sql || selectedNode?.sql || 'No SQL generated yet.'}
            </pre>
          )}

          {activeBottomTab === 'results' && (
            <div>
              {finalResult?.rows && finalResult.rows.length > 0 ? (
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
                      {finalResult.columns.map((col) => (
                        <th key={col} className={css({ p: '2', fontWeight: 'bold', color: 'gray.700' })}>
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {finalResult.rows.map((row, idx) => (
                      <tr key={idx} className={css({ borderBottom: '1px solid', borderColor: 'gray.100' })}>
                        {finalResult.columns.map((col) => (
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
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>{nodes.length}</p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Rows Produced</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>
                  {finalResult?.row_count ?? 0} rows
                </p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Total Latency</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1' })}>
                  {finalResult?.execution_time_ms != null ? `${finalResult.execution_time_ms} ms` : '—'}
                </p>
              </div>

              <div className={css({ p: '3', borderRadius: 'md', bg: 'gray.50', border: '1px solid', borderColor: 'gray.200' })}>
                <p className={css({ color: 'gray.500' })}>Model Decision Adapter</p>
                <p className={css({ fontSize: 'base', fontWeight: 'bold', mt: '1', textTransform: 'uppercase', color: 'blue.700' })}>
                  {activeAgent}
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