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

import {
  Bookmark,
  GitBranch,
  Play,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Footprints,
  StepForward,
  Square,
} from 'lucide-react'

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
    () =>
      toFlowNodes(session.nodes, {
        edges: session.edges,
        selectedId: session.selectedNodeId,
      }),
    [
      session.nodes,
      session.edges,
      session.selectedNodeId,
    ],
  )

  const flowEdges = useMemo(
    () => toFlowEdges(session.edges),
    [session.edges],
  )

  const selectedNode =
    flowNodes.find(
      (node) => node.id === session.selectedNodeId,
    )?.data ?? null

  const result = run.result

  const isRunning = run.isRunning
  const isOnline = session.isOnline
  const isCheckingBackend = session.isChecking

  const errorMessage = session.error?.message ?? run.error?.message ?? null


  const handleRun = () => {
    if (!isRunning && inputQuery.trim()) {
      run.start(inputQuery, {
        mode: 'auto',
      })
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
      if (
        change.type === 'position' &&
        change.position
      ) {
        setNodePosition(
          change.id,
          change.position,
        )
      }
    }
  }, [])

  const onEdgesChange = useCallback(() => {}, [])

  const status = run.isFinished
    ? 'completed'
    : run.isFailed || run.isAborted || run.isDeclined
      ? 'failed'
      : 'ready'

  return (
    <main
      className={css({
        display: 'grid',

        gridTemplateColumns: {
          base: '1fr',
          lg: '260px minmax(0, 1fr) 320px',
        },

        gridTemplateRows: {
          base: '54px auto auto auto auto',
          lg: '54px minmax(0, 1fr) 200px',
        },

        height: {
          lg: '100vh',
        },

        minH: '100vh',

        overflow: {
          lg: 'hidden',
        },

        bg: '#fafafa',

        color: '#18181b',
      })}
    >
      {/* ======================================================
          TOP NAVBAR
      ====================================================== */}

      <nav
        className="trace-navbar"
        style={{
          gridColumn: '1 / -1',
        }}
      >
        <div className="trace-nav-left">
          <span className="trace-nav-context">
            Reasoning Explorer
          </span>
        </div>

        <div className="trace-logo">
          TRACE
        </div>

        <div className="trace-nav-right">
          <span className="trace-database">
            university.sqlite
          </span>

          <span
            className={`trace-backend-status ${
              isOnline ? 'online' : 'offline'
            }`}
          >
            <span className="trace-status-dot" />

            {isCheckingBackend
              ? 'Checking backend...'
              : isOnline
                ? 'Backend online'
                : 'Backend offline'}
          </span>
        </div>
      </nav>

      {/* ======================================================
          LEFT SIDEBAR
      ====================================================== */}

      <aside
        className={css({
          gridColumn: {
            lg: '1',
          },

          gridRow: {
            lg: '2 / 4',
          },

          display: 'flex',

          flexDir: 'column',

          gap: '4',

          p: '4',

          bg: '#fafafa',

          borderRightWidth: {
            lg: '1px',
          },

          borderBottomWidth: {
            base: '1px',
            lg: '0',
          },

          borderColor: '#e4e4e7',

          overflowY: 'auto',
        })}
      >
        {/* Workspace heading */}

        <div
          className={css({
            pb: '4',

            borderBottom:
              '1px solid #e4e4e7',
          })}
        >
          <p
            className={css({
              fontSize: '10px',

              fontWeight: '700',

              color: '#71717a',

              textTransform: 'uppercase',

              letterSpacing: '0.08em',
            })}
          >
            Workspace
          </p>

          <h1
            className={css({
              mt: '1',

              fontSize: '2xl',

              lineHeight: '1.15',

              fontWeight: '800',

              letterSpacing: '-0.025em',

              color: '#18181b',
            })}
          >
            Explorer
          </h1>
        </div>

        {/* Search queries */}

        <input
          className={`trace-input ${css({
            w: 'full',

            h: '11',

            px: '4',

            borderWidth: '2px',

            borderColor: '#c9c9cf',

            borderRadius: '10px',

            bg: '#f4f4f5',

            color: '#18181b',

            fontSize: 'sm',

            fontWeight: '600',

            outline: 'none',

            _placeholder: {
              color: '#a1a1aa',

              fontWeight: '500',
            },

            _focus: {
              borderColor: '#18181b',

              bg: '#fafafa',

              boxShadow:
                '0 0 0 1px #18181b',
            },
          })}`}
          placeholder="Search queries..."
          aria-label="Search queries"
          value={history.filter.q}
          onChange={(event) =>
            history.setFilter({
              q: event.target.value,
            })
          }
        />

        {/* Filters */}

        <div
          className={css({
            display: 'flex',

            gap: '2',
          })}
        >
          {[
            ['All', null],
            ['Success', 'completed'],
            ['Failed', 'failed'],
          ].map(([label, value]) => (
            <Button
              key={label}
              size="sm"

              variant={
                history.filter.status === value
                  ? 'solid'
                  : 'outline'
              }

              className={`trace-sidebar-button ${css({
                flex: 1,

                minH: '40px',

                borderRadius: '9px',

                fontWeight: '700',
              })}`}

              onClick={() =>
                history.setFilter({
                  status: value,
                })
              }
            >
              {label}
            </Button>
          ))}
        </div>

        <Button
          variant="outline"

          onClick={handleNewQuery}

          className={`trace-sidebar-button ${css({
            minH: '40px',

            borderRadius: '9px',

            borderColor: '#d4d4d8',

            fontWeight: '600',

            _hover: {
              borderColor: '#18181b',

              bg: '#18181b',

              color: 'white',
            },
          })}`}
        >
          + New query
        </Button>

        {/* ==================================================
            SESSION HISTORY
        ================================================== */}

        <div
          className={css({
            display: 'grid',

            gap: '2',

            fontSize: 'sm',
          })}
        >
          <strong
            className={css({
              mt: '1',

              color: '#52525b',

              fontSize: '10px',

              fontWeight: '700',

              textTransform: 'uppercase',

              letterSpacing: '0.07em',
            })}
          >
            Session history
          </strong>

          {history.loading && (
            <p
              className={css({
                fontSize: 'xs',

                color: '#71717a',

                fontWeight: '500',
              })}
            >
              Loading sessions…
            </p>
          )}

          {history.unsupported && (
            <p
              className={css({
                fontSize: 'xs',

                color: 'amber.700',
              })}
            >
              History unavailable — this backend
              build has no GET /queries endpoint.
            </p>
          )}

          {!history.loading &&
            !history.unsupported &&
            history.sessions.length === 0 && (
              <p
                className={css({
                  fontSize: 'xs',

                  color: '#71717a',
                })}
              >
                No stored sessions yet.
              </p>
            )}

          <div
            className={css({
              display: 'grid',

              gap: '1',
            })}
          >
            {history.sessions.map((item) => {
              const isSelected =
                item.id === session.session.id

              return (
                <button
                  key={item.id}

                  className={`trace-history-row ${css({
                    width: '100%',

                    textAlign: 'left',

                    px: '3',

                    py: '2.5',

                    borderRadius: '9px',

                    cursor: 'pointer',

                    background: isSelected
                      ? '#f4f4f5'
                      : '#ffffff',

                    borderWidth: '1px',

                    borderStyle: 'solid',

                    borderColor: isSelected
                      ? '#d4d4d8'
                      : '#ececef',

                    borderLeftWidth: '3px',

                    borderLeftColor: isSelected
                      ? '#18181b'
                      : 'transparent',

                    _hover: {
                      bg: '#18181b',

                      color: 'white',

                      borderColor: '#18181b',

                      borderLeftColor: '#18181b',
                    },
                  })}`}

                  onClick={() => {
                    setInputQuery(
                      item.request ?? '',
                    )

                    session.openSession(
                      item.id,
                    )
                  }}
                >
                  <span
                    className={css({
                      display: 'block',

                      fontSize: 'xs',

                      lineHeight: '1.4',

                      fontWeight: '600',

                      color: 'inherit',
                    })}
                  >
                    {item.request ||
                      '(untitled)'}
                  </span>

                  <span
                    className={css({
                      display: 'block',

                      mt: '0.5',

                      color: isSelected
                        ? '#71717a'
                        : '#a1a1aa',

                      fontSize: '10px',

                      fontWeight: '500',

                      _groupHover: {
                        color: 'white',
                      },
                    })}
                  >
                    {item.status} ·{' '}
                    {item.stateCount ?? 0}{' '}
                    states
                    {item.hasFailure
                      ? ' · has failure'
                      : ''}
                  </span>
                </button>
              )
            })}
          </div>

          <Button
            size="sm"

            variant="outline"

            onClick={history.refresh}

            disabled={history.loading}

            className={`trace-sidebar-button ${css({
              mt: '1',

              borderRadius: '8px',

              borderColor: '#d4d4d8',

              fontWeight: '600',
            })}`}
          >
            <RefreshCw
              size={12}

              className={css({
                mr: '1.5',
              })}
            />

            Refresh history
          </Button>
        </div>

        {/* ==================================================
            AGENT
        ================================================== */}

        <div
          className={css({
            mt: 'auto',

            pt: '4',

            display: 'flex',

            flexDirection: 'column',

            gap: '2',

            borderTop:
              '1px solid #e4e4e7',
          })}
        >
          <div
            className={css({
              display: 'flex',

              justifyContent: 'space-between',

              alignItems: 'center',

              fontSize: 'xs',

              color: '#71717a',
            })}
          >
            <span
              className={css({
                fontWeight: '600',
              })}
            >
              Active Agent
            </span>

            <span
              className={css({
                px: '2',

                py: '0.5',

                borderRadius: '5px',

                bg: '#18181b',

                color: 'white',

                fontSize: '10px',

                fontWeight: '700',

                textTransform: 'uppercase',

                letterSpacing: '0.04em',
              })}
            >
              {agent.agent ?? '—'}
            </span>
          </div>

          {agent.registered.length > 0 && (
            <select
              aria-label="Select decision agent"

              value={agent.agent ?? ''}

              onChange={(event) =>
                agent.selectAgent(
                  event.target.value,
                )
              }

              disabled={agent.loading}

              className={css({
                minH: '34px',

                px: '2',

                py: '1',

                bg: 'white',

                borderWidth: '1px',

                borderColor: '#d4d4d8',

                borderRadius: '8px',

                color: '#18181b',

                fontSize: 'xs',

                fontWeight: '500',

                outline: 'none',

                _focus: {
                  borderColor: '#18181b',
                },
              })}
            >
              {agent.registered.map((name) => (
                <option
                  key={name}
                  value={name}
                >
                  {name}
                </option>
              ))}
            </select>
          )}

          <Button
            variant="outline"

            size="sm"

            className={`trace-sidebar-button ${css({
              borderRadius: '8px',

              borderColor: '#d4d4d8',

              fontWeight: '600',
            })}`}
          >
            + Add database
          </Button>
        </div>
      </aside>

      {/* ======================================================
          CENTER
      ====================================================== */}

      <section
        className={css({
          gridColumn: {
            lg: '2',
          },

          gridRow: {
            lg: '2',
          },

          minW: '0',

          minH: '0',

          display: 'grid',

          gridTemplateRows:
            'auto minmax(360px, 1fr)',

          bg: 'white',
        })}
      >
        {/* ==================================================
            QUERY HEADER
        ================================================== */}

        <header
          className={css({
            display: 'grid',

            gap: '3',

            px: '5',

            py: '4',

            bg: 'white',

            borderBottomWidth: '1px',

            borderColor: '#e4e4e7',
          })}
        >
          <div
            className={css({
              display: 'flex',

              justifyContent: 'space-between',

              alignItems: 'flex-start',

              gap: '3',
            })}
          >
            <div
              className={css({
                minW: '0',
              })}
            >
              <p
                className={css({
                  fontSize: '10px',

                  color: '#71717a',

                  fontWeight: '700',

                  textTransform: 'uppercase',

                  letterSpacing: '0.07em',
                })}
              >
                {session.session.id
                  ? `Session ${session.session.id.slice(
                      0,
                      8,
                    )}`
                  : 'New query'}
              </p>

              <h2
                className={css({
                  mt: '1',

                  fontSize: 'lg',

                  fontWeight: '700',

                  color: '#18181b',

                  letterSpacing: '-0.015em',

                  lineHeight: '1.35',
                })}
              >
                {inputQuery ||
                  'Enter a database query'}
              </h2>
            </div>

            {/* Execution status */}

            <div
              className={css({
                display: 'flex',

                alignItems: 'center',

                gap: '2',

                flexShrink: 0,
              })}
            >
              {isRunning ? (
                <span
                  className={css({
                    display: 'inline-flex',

                    alignItems: 'center',

                    gap: '1.5',

                    px: '2.5',

                    py: '1',

                    borderRadius: 'full',

                    bg: '#f4f4f5',

                    border:
                      '1px solid #d4d4d8',

                    color: '#18181b',

                    fontSize: 'xs',

                    fontWeight: '600',
                  })}
                >
                  <RefreshCw
                    size={12}

                    className={css({
                      animation:
                        'spin 1s linear infinite',
                    })}
                  />

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

                    border: '1px solid',

                    borderColor: 'amber.200',

                    color: 'amber.800',

                    fontSize: 'xs',

                    fontWeight: '600',
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

                    border: '1px solid',

                    borderColor: 'green.200',

                    color: 'green.700',

                    fontSize: 'xs',

                    fontWeight: '600',
                  })}
                >
                  <CheckCircle2 size={12} />

                  Completed
                </span>
              ) : run.isDeclined ? (
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
                  <AlertTriangle size={12} />
                  Declined
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

                    border: '1px solid',

                    borderColor: 'red.200',

                    color: 'red.700',

                    fontSize: 'xs',

                    fontWeight: '600',
                  })}
                >
                  <AlertCircle size={12} />

                  Failed
                </span>
              ) : (
                <span
                  className={css({
                    color: '#a1a1aa',

                    fontSize: 'xs',

                    fontWeight: '600',
                  })}
                >
                  Ready
                </span>
              )}
            </div>
          </div>

          {/* ==================================================
              MAIN SEARCH / QUERY BAR
          ================================================== */}

          <div
            className={css({
              display: 'flex',

              gap: '2',
            })}
          >
            <input
              className={`trace-input ${css({
                flex: '1',

                minW: '0',

                h: '12',

                px: '4',

                borderWidth: '2px',

                borderColor: '#c4c4c8',

                borderRadius: '10px',

                /* requested grey interior */
                bg: '#f1f1f3',

                color: '#18181b',

                fontSize: 'sm',

                fontWeight: '600',

                outline: 'none',

                _placeholder: {
                  color: '#8f8f96',

                  fontWeight: '500',
                },

                _focus: {
                  borderColor: '#18181b',

                  bg: '#f4f4f5',

                  boxShadow:
                    '0 0 0 1px #18181b',
                },

                _disabled: {
                  bg: '#f4f4f5',

                  opacity: 0.7,
                },
              })}`}

              value={inputQuery}

              onChange={(event) =>
                setInputQuery(
                  event.target.value,
                )
              }

              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleRun()
                }
              }}

              placeholder="Ask natural-language query to construct SQL graph..."

              aria-label="Query request"

              disabled={isRunning}
            />

            <Button
              onClick={handleRun}

              disabled={isRunning}

              className={css({
                minW: '86px',

                minH: '48px',

                borderRadius: '10px',

                fontWeight: '700',
              })}
            >
              {isRunning ? (
                <>
                  <RefreshCw
                    size={14}

                    className={css({
                      animation:
                        'spin 1s linear infinite',

                      mr: '1',
                    })}
                  />

                  Running
                </>
              ) : (
                <>
                  <Play
                    size={14}

                    className={css({
                      mr: '1',
                    })}
                  />

                  Run
                </>
              )}
            </Button>

            <Button
              variant="outline"

              onClick={handleStep}

              disabled={isRunning}

              className={css({
                minH: '48px',

                borderRadius: '10px',

                borderColor: '#d4d4d8',

                fontWeight: '600',
              })}
            >
              <StepForward
                size={14}

                className={css({
                  mr: '1',
                })}
              />

              Step
            </Button>

            <Button
              variant="outline"

              onClick={run.abort}

              disabled={!isRunning}

              className={css({
                minH: '48px',

                borderRadius: '10px',

                borderColor: '#d4d4d8',

                fontWeight: '600',
              })}
            >
              <Square
                size={14}

                className={css({
                  mr: '1',
                })}
              />

              Stop
            </Button>

            <Button
              variant="outline"

              onClick={() => run.resume()}

              disabled={!run.isPaused}

              title="Continue the paused run in auto mode"

              className={css({
                minH: '48px',

                borderRadius: '10px',

                borderColor: '#d4d4d8',

                fontWeight: '600',
              })}
            >
              <Footprints
                size={14}

                className={css({
                  mr: '1',
                })}
              />

              Resume
            </Button>
          </div>

          {errorMessage && (
            <div
              className={css({
                p: '2',
                borderRadius: 'md',
                bg: run.isDeclined ? 'amber.50' : 'red.50',
                border: '1px solid',
                borderColor: run.isDeclined ? 'amber.200' : 'red.200',
                color: run.isDeclined ? 'amber.800' : 'red.700',
                fontSize: 'xs',
                display: 'flex',

                alignItems: 'center',

                gap: '2',

                borderRadius: '8px',

                bg: 'red.50',

                border: '1px solid',

                borderColor: 'red.200',

                color: 'red.700',

                fontSize: 'xs',

                fontWeight: '500',
              })}
            >
              <AlertCircle size={14} />

              <span>
                {errorMessage}
              </span>

              <Button
                size="xs"

                variant="ghost"

                onClick={
                  session.clearError
                }
              >
                Dismiss
              </Button>
            </div>
          )}
        </header>

        {/* ==================================================
            TRACE TREE

            UNCHANGED
        ================================================== */}

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

            onSelectNode={(nodeData) =>
              session.selectNode(
                nodeData.id,
              )
            }

            onNodesChange={onNodesChange}

            onEdgesChange={onEdgesChange}
          />
        </div>
      </section>

      {/* ======================================================
          RIGHT SIDEBAR
      ====================================================== */}

      <aside
        className={css({
          gridColumn: {
            lg: '3',
          },

          gridRow: {
            lg: '2/4',
          },

          p: '4',

          bg: '#fafafa',

          borderLeftWidth: {
            lg: '1px',
          },

          borderColor: '#e4e4e7',

          overflowY: 'auto',

          display: 'flex',

          flexDirection: 'column',

          gap: '3',
        })}
      >
        {/* ==================================================
            NODE INSPECTION HEADER

            NO BLACK BOX
        ================================================== */}

        <div
          className={css({
            pb: '3',

            borderBottom:
              '1px solid #e4e4e7',
          })}
        >
          <p
            className={css({
              color: '#52525b',

              fontSize: '11px',

              fontWeight: '700',

              letterSpacing: '0.08em',
            })}
          >
            NODE INSPECTION
          </p>
        </div>

        {selectedNode ? (
          <div
            className={css({
              display: 'grid',

              gap: '4',
            })}
          >
            {/* Action */}

            <div
              className={css({
                pb: '3',

                borderBottom:
                  '1px solid #e4e4e7',
              })}
            >
              <p
                className={css({
                  fontSize: '10px',

                  color: '#71717a',

                  fontWeight: '600',

                  textTransform: 'uppercase',

                  letterSpacing: '0.05em',
                })}
              >
                Action
              </p>

              <h2
                className={css({
                  mt: '1',

                  fontSize: 'lg',

                  fontWeight: '700',

                  color: '#18181b',

                  letterSpacing: '-0.015em',
                })}
              >
                {selectedNode.action ||
                  'Root state (no action)'}
              </h2>
            </div>

            {/* Parameters */}

            <div>
              <p
                className={css({
                  mb: '1.5',

                  fontSize: '10px',

                  color: '#71717a',

                  fontWeight: '600',

                  textTransform: 'uppercase',

                  letterSpacing: '0.05em',
                })}
              >
                Parameters
              </p>

              <pre
                className={css({
                  margin: '0',

                  p: '2.5',

                  bg: '#f4f4f5',

                  border:
                    '1px solid #d4d4d8',

                  borderRadius: '8px',

                  color: '#27272a',

                  fontSize: '11px',

                  fontWeight: '500',

                  fontFamily:
                    '"SFMono-Regular", "SF Mono", Consolas, monospace',

                  lineHeight: '1.5',

                  whiteSpace: 'pre-wrap',

                  wordBreak: 'break-word',
                })}
              >
                {typeof selectedNode.params ===
                  'object' &&
                selectedNode.params !== null
                  ? JSON.stringify(
                      selectedNode.params,
                      null,
                      2,
                    )
                  : String(
                      selectedNode.params ||
                        'None',
                    )}
              </pre>
            </div>

            {/* Status / confidence */}

            <div
              className={css({
                display: 'grid',

                gridTemplateColumns:
                  '1fr 1fr',

                gap: '3',
              })}
            >
              <div>
                <p
                  className={css({
                    fontSize: '10px',

                    color: '#71717a',

                    fontWeight: '600',

                    textTransform: 'uppercase',

                    letterSpacing: '0.04em',
                  })}
                >
                  Status
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'sm',

                    fontWeight: '700',

                    color:
                      selectedNode.status ===
                      'FAILED'
                        ? 'red.700'
                        : 'green.700',
                  })}
                >
                  {selectedNode.status}
                </p>
              </div>

              <div>
                <p
                  className={css({
                    fontSize: '10px',

                    color: '#71717a',

                    fontWeight: '600',

                    textTransform: 'uppercase',

                    letterSpacing: '0.04em',
                  })}
                >
                  Confidence
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'sm',

                    fontWeight: '700',

                    color: '#18181b',
                  })}
                >
                  {selectedNode.confidence != null
                    ? `${
                        selectedNode.confidence <= 1
                          ? Math.round(
                              selectedNode.confidence *
                                100,
                            )
                          : Math.round(
                              selectedNode.confidence,
                            )
                      }%`
                    : '—'}
                </p>
              </div>
            </div>

            {/* Metrics */}

            <div
              className={css({
                display: 'grid',

                gridTemplateColumns:
                  '1fr 1fr',

                gap: '3',

                p: '3',

                bg: 'white',

                border:
                  '1px solid #dedee3',

                borderRadius: '9px',
              })}
            >
              <div>
                <p
                  className={css({
                    fontSize: '10px',

                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Rows produced
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'sm',

                    color: '#18181b',

                    fontWeight: '700',
                  })}
                >
                  {selectedNode.row_count !=
                  null
                    ? `${selectedNode.row_count} rows`
                    : '—'}
                </p>
              </div>

              <div>
                <p
                  className={css({
                    fontSize: '10px',

                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Execution time
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'sm',

                    color: '#18181b',

                    fontWeight: '700',
                  })}
                >
                  {selectedNode.execution_time_ms !=
                  null
                    ? `${selectedNode.execution_time_ms} ms`
                    : '—'}
                </p>
              </div>
            </div>

            {/* Branch / State */}

            <div>
              <p
                className={css({
                  fontSize: '10px',

                  color: '#71717a',

                  fontWeight: '600',

                  textTransform: 'uppercase',

                  letterSpacing: '0.04em',
                })}
              >
                Branch / State ID
              </p>

              <p
                className={css({
                  mt: '1',

                  color: '#3f3f46',

                  fontSize: '11px',

                  fontWeight: '500',

                  fontFamily:
                    '"SFMono-Regular", "SF Mono", Consolas, monospace',

                  lineHeight: '1.5',

                  wordBreak: 'break-all',
                })}
              >
                {selectedNode.branch_id ||
                  'main'}{' '}
                · {selectedNode.id}
              </p>
            </div>

            {/* Checkpoint */}

            <div>
              <p
                className={css({
                  fontSize: '10px',

                  color: '#71717a',

                  fontWeight: '600',

                  textTransform: 'uppercase',

                  letterSpacing: '0.04em',
                })}
              >
                Checkpoint
              </p>

              <p
                className={css({
                  mt: '1',

                  fontSize: 'xs',

                  fontWeight: '600',

                  color:
                    selectedNode.checkpoint_id
                      ? 'amber.700'
                      : '#71717a',
                })}
              >
                {selectedNode.checkpoint_id
                  ? `◆ ${selectedNode.checkpoint_id}`
                  : 'None'}
              </p>
            </div>

            {/* Failure */}

            {selectedNode.failure_reason && (
              <div
                className={css({
                  p: '3',

                  borderRadius: '8px',

                  bg: 'red.50',

                  border: '1px solid',

                  borderColor: 'red.200',
                })}
              >
                <p
                  className={css({
                    fontSize: '10px',

                    color: 'red.700',

                    fontWeight: '700',

                    textTransform: 'uppercase',
                  })}
                >
                  Failure Reason
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'xs',

                    color: 'red.800',

                    fontWeight: '500',
                  })}
                >
                  {selectedNode.failure_reason}
                </p>
              </div>
            )}

            {/* Recovery clarification */}

            {selectedNode.clarification && (
              <div
                className={css({
                  p: '3',

                  borderRadius: '8px',

                  bg: 'blue.50',

                  border: '1px solid',

                  borderColor: 'blue.200',
                })}
              >
                <p
                  className={css({
                    fontSize: '10px',

                    color: 'blue.700',

                    fontWeight: '700',

                    textTransform: 'uppercase',
                  })}
                >
                  Recovery Clarification
                </p>

                <p
                  className={css({
                    mt: '1',

                    fontSize: 'xs',

                    color: 'blue.800',

                    fontWeight: '500',
                  })}
                >
                  {selectedNode.clarification}
                </p>
              </div>
            )}

            {/* ==================================================
                ACTION BUTTONS
            ================================================== */}

            <div
              className={css({
                mt: '1',

                pt: '3',

                display: 'flex',

                flexDirection: 'column',

                gap: '2',

                borderTop:
                  '1px solid #e4e4e7',
              })}
            >
              <Button
                size="sm"

                variant="outline"

                onClick={() =>
                  handleCreateCheckpoint(
                    selectedNode.id,
                  )
                }

                disabled={
                  Boolean(
                    selectedNode.checkpoint_id,
                  ) ||
                  !session.session.id
                }

                className={css({
                  borderRadius: '8px',

                  borderColor: '#d4d4d8',

                  fontWeight: '600',

                  _hover: {
                    bg: '#18181b',

                    color: 'white',

                    borderColor: '#18181b',
                  },
                })}
              >
                <Bookmark
                  size={13}

                  className={css({
                    mr: '1.5',
                  })}
                />

                {selectedNode.checkpoint_id
                  ? 'Checkpoint Pinned'
                  : 'Set Checkpoint'}
              </Button>

              {!selectedNode.checkpoint_id && (
                <input
                  value={checkpointLabel}

                  onChange={(event) =>
                    setCheckpointLabel(
                      event.target.value,
                    )
                  }

                  aria-label="Checkpoint label"

                  placeholder="Checkpoint label"

                  className={`trace-input ${css({
                    h: '8',

                    px: '2.5',

                    bg: 'white',

                    borderWidth: '1px',

                    borderColor: '#d4d4d8',

                    borderRadius: '8px',

                    color: '#18181b',

                    fontSize: 'xs',

                    fontWeight: '500',

                    outline: 'none',

                    _focus: {
                      borderColor: '#18181b',

                      boxShadow:
                        '0 0 0 1px #18181b',
                    },
                  })}`}
                />
              )}

              <Button
                size="sm"

                variant="outline"

                onClick={
                  handleRecoveryToggle
                }

                disabled={
                  !session.session.id ||
                  session.busy?.recover === true
                }

                className={css({
                  borderRadius: '8px',

                  borderColor: '#18181b',

                  fontWeight: '600',

                  _hover: {
                    bg: '#18181b',

                    color: 'white',
                  },
                })}
              >
                <GitBranch
                  size={13}

                  className={css({
                    mr: '1.5',
                  })}
                />

                {recoveryOpen
                  ? 'Close recovery'
                  : 'Branch / Recompute'}
              </Button>

              {recoveryOpen && (
                <form
                  onSubmit={(event) =>
                    handleRecoverySubmit(
                      event,
                      selectedNode,
                    )
                  }

                  className={css({
                    display: 'grid',

                    gap: '2',

                    p: '3',

                    bg: 'white',

                    border:
                      '1px solid #d4d4d8',

                    borderRadius: '8px',
                  })}
                >
                  <label
                    htmlFor="recovery-filter"

                    className={css({
                      color: '#52525b',

                      fontSize: '10px',

                      fontWeight: '600',

                      textTransform: 'uppercase',
                    })}
                  >
                    Correction filter
                  </label>

                  <input
                    id="recovery-filter"

                    value={recoveryInput}

                    onChange={(event) =>
                      setRecoveryInput(
                        event.target.value,
                      )
                    }

                    placeholder="gpa > 8.5"

                    className={`trace-input ${css({
                      h: '8',

                      px: '2.5',

                      borderWidth: '1px',

                      borderColor: '#d4d4d8',

                      borderRadius: '8px',

                      bg: '#fafafa',

                      color: '#18181b',

                      fontSize: 'xs',

                      outline: 'none',

                      _focus: {
                        borderColor: '#18181b',
                      },
                    })}`}
                  />

                  {actionError && (
                    <p
                      className={css({
                        color: 'red.700',

                        fontSize: 'xs',

                        fontWeight: '500',
                      })}
                    >
                      {actionError}
                    </p>
                  )}

                  <div
                    className={css({
                      display: 'flex',

                      gap: '2',
                    })}
                  >
                    <Button
                      size="sm"

                      type="submit"

                      disabled={
                        session.busy?.recover ===
                        true
                      }
                    >
                      Apply correction
                    </Button>

                    <Button
                      size="sm"

                      type="button"

                      variant="ghost"

                      onClick={
                        handleRecoveryCancel
                      }
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}

              <Button
                size="sm"

                variant="outline"

                onClick={() =>
                  session.applyAction({
                    action_type: 'LIMIT',

                    parameters: {
                      limit: 5,
                    },
                  })
                }

                disabled={
                  !session.session.id
                }

                title="Apply an explicit action to the current state"

                className={css({
                  borderRadius: '8px',

                  borderColor: '#d4d4d8',

                  fontWeight: '600',
                })}
              >
                Apply LIMIT 5
              </Button>

              <Button
                size="sm"

                variant="outline"

                onClick={
                  session.forceFailure
                }

                disabled={
                  !session.session.id
                }

                title="Apply FILTER on column CGPA, which the backend always rejects"

                className={css({
                  borderRadius: '8px',

                  borderColor: '#d4d4d8',

                  fontWeight: '600',
                })}
              >
                Trigger demo failure
              </Button>

              <Button
                size="sm"

                variant="outline"

                onClick={run.finish}

                disabled={
                  !session.session.id
                }

                className={css({
                  borderRadius: '8px',

                  borderColor: '#d4d4d8',

                  fontWeight: '600',
                })}
              >
                Finish now
              </Button>
            </div>

            {/* ==================================================
                PREVIEW
            ================================================== */}

            {session.previewState(
              selectedNode.id,
            ) && (
              <div>
                <p
                  className={css({
                    color: '#71717a',

                    fontSize: '10px',

                    fontWeight: '600',

                    textTransform: 'uppercase',

                    letterSpacing: '0.04em',
                  })}
                >
                  Intermediate preview (
                  {session.previewState(
                    selectedNode.id,
                  ).rowCount ?? 0}{' '}
                  rows)
                </p>

                <div
                  className={css({
                    mt: '2',

                    overflowX: 'auto',

                    border:
                      '1px solid #e4e4e7',

                    borderRadius: '8px',
                  })}
                >
                  <table
                    className={css({
                      width: '100%',

                      borderCollapse: 'collapse',

                      textAlign: 'left',

                      fontSize: '10px',
                    })}
                  >
                    <thead>
                      <tr
                        className={css({
                          bg: '#f4f4f5',

                          borderBottom:
                            '1px solid',

                          borderColor: '#e4e4e7',
                        })}
                      >
                        {(
                          session.previewState(
                            selectedNode.id,
                          ).columns ?? []
                        ).map((col) => (
                          <th
                            key={col}

                            className={css({
                              p: '1.5',

                              color: '#52525b',

                              fontWeight: '700',
                            })}
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>

                    <tbody>
                      {(
                        session.previewState(
                          selectedNode.id,
                        ).rows ?? []
                      )
                        .slice(0, 5)
                        .map((row, idx) => (
                          <tr
                            key={idx}

                            className={css({
                              borderBottom:
                                '1px solid',

                              borderColor:
                                '#f4f4f5',
                            })}
                          >
                            {(
                              session.previewState(
                                selectedNode.id,
                              ).columns ?? []
                            ).map((col) => (
                              <td
                                key={col}

                                className={css({
                                  p: '1.5',

                                  color: '#3f3f46',

                                  fontWeight: '500',
                                })}
                              >
                                {String(
                                  row[col] ?? '',
                                )}
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
          <div
            className={css({
              py: '2',
            })}
          >
            <h2
              className={css({
                color: '#18181b',

                fontSize: 'sm',

                fontWeight: '700',
              })}
            >
              Select a node
            </h2>

            <p
              className={css({
                mt: '1',

                color: '#71717a',

                fontSize: 'xs',

                fontWeight: '500',

                lineHeight: '1.6',
              })}
            >
              Click any step in the query graph to
              inspect its parameters, preview rows,
              and recovery options.
            </p>
          </div>
        )}
      </aside>

      {/* ======================================================
          BOTTOM PANEL
      ====================================================== */}

      <section
        className={css({
          gridColumn: {
            lg: '2 ',
          },

          gridRow: {
            lg: '3',
          },

          p: '4',

          bg: '#dededf',

border: '1px solid #b0b0b0',
borderRadius: '10px 10px 0 0',

          display: 'flex',

          flexDirection: 'column',

          overflow: 'hidden',
        })}
      >
        {/* Tabs */}

        <div
          className={css({
            display: 'flex',

            gap: '6',

            borderBottomWidth: '1px',

            borderColor: '#e4e4e7',
          })}
        >
          {[
            ['sql', 'Final SQL'],

            [
              'results',

              `Results${
                result?.rowCount != null
                  ? ` (${result.rowCount})`
                  : ''
              }`,
            ],

            ['summary', 'Summary'],
          ].map(([id, label]) => (
            <button
              key={id}

              onClick={() =>
                setActiveBottomTab(id)
              }

              className={css({
                pb: '2',

                bg: 'transparent',

                borderTop: 'none',

                borderLeft: 'none',

                borderRight: 'none',

                borderBottomWidth:
                  activeBottomTab === id
                    ? '2px'
                    : '0',

                borderColor: '#18181b',

                color:
                  activeBottomTab === id
                    ? '#18181b'
                    : '#71717a',

                fontSize: 'sm',

                fontWeight:
                  activeBottomTab === id
                    ? '700'
                    : '500',

                cursor: 'pointer',
              })}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className={css({
            flex: 1,

            minH: 0,

            mt: '3',

            overflowY: 'auto',
          })}
        >
          {/* SQL */}

          {activeBottomTab === 'sql' && (
            <pre
              className={css({
                p: '3',

                bg: '#f4f4f5',

                border:
                  '1px solid #e4e4e7',

                borderRadius: '8px',

                color: '#27272a',

                fontFamily:
                  '"SFMono-Regular", "SF Mono", Consolas, monospace',

                fontSize: 'xs',

                fontWeight: '500',

                lineHeight: '1.6',

                whiteSpace: 'pre-wrap',
              })}
            >
              {result?.sql ||
                selectedNode?.sql ||
                'No SQL generated yet.'}
            </pre>
          )}

          {/* Results */}

          {activeBottomTab === 'results' && (
            <div>
              {result?.rows &&
              result.rows.length > 0 ? (
                <table
                  className={css({
                    width: '100%',

                    borderCollapse: 'collapse',

                    textAlign: 'left',

                    fontSize: 'xs',
                  })}
                >
                  <thead>
                    <tr
                      className={css({
                        bg: '#f4f4f5',

                        borderBottom:
                          '1px solid',

                        borderColor: '#e4e4e7',
                      })}
                    >
                      {result.columns.map((col) => (
                        <th
                          key={col}

                          className={css({
                            p: '2',

                            color: '#52525b',

                            fontWeight: '700',
                          })}
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {result.rows.map(
                      (row, idx) => (
                        <tr
                          key={idx}

                          className={css({
                            borderBottom:
                              '1px solid',

                            borderColor:
                              '#f4f4f5',
                          })}
                        >
                          {result.columns.map(
                            (col) => (
                              <td
                                key={col}

                                className={css({
                                  p: '2',

                                  color: '#3f3f46',

                                  fontWeight: '500',
                                })}
                              >
                                {String(
                                  row[col] ?? '',
                                )}
                              </td>
                            ),
                          )}
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              ) : (
                <p
                  className={css({
                    color: '#71717a',

                    fontSize: 'xs',

                    fontWeight: '500',
                  })}
                >
                  No results produced. Run a query
                  to view final returned records.
                </p>
              )}
            </div>
          )}

          {/* Summary */}

          {activeBottomTab === 'summary' && (
            <div
              className={css({
                display: 'grid',

                gridTemplateColumns: {
                  base: '1fr 1fr',

                  xl: 'repeat(4, 1fr)',
                },

                gap: '4',

                fontSize: 'xs',
              })}
            >
              <div
                className={css({
                  p: '3',

                  bg: '#fafafa',

                  border:
                    '1px solid #e4e4e7',

                  borderRadius: '8px',
                })}
              >
                <p
                  className={css({
                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Total Actions
                </p>

                <p
                  className={css({
                    mt: '1',

                    color: '#18181b',

                    fontSize: 'base',

                    fontWeight: '700',
                  })}
                >
                  {session.stats.actionCount}
                </p>
              </div>

              <div
                className={css({
                  p: '3',

                  bg: '#fafafa',

                  border:
                    '1px solid #e4e4e7',

                  borderRadius: '8px',
                })}
              >
                <p
                  className={css({
                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Rows Produced
                </p>

                <p
                  className={css({
                    mt: '1',

                    color: '#18181b',

                    fontSize: 'base',

                    fontWeight: '700',
                  })}
                >
                  {result?.rowCount ??
                    session.stats.rowCount ??
                    0}{' '}
                  rows
                </p>
              </div>

              <div
                className={css({
                  p: '3',

                  bg: '#fafafa',

                  border:
                    '1px solid #e4e4e7',

                  borderRadius: '8px',
                })}
              >
                <p
                  className={css({
                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Total Latency
                </p>

                <p
                  className={css({
                    mt: '1',

                    color: '#18181b',

                    fontSize: 'base',

                    fontWeight: '700',
                  })}
                >
                  {(result?.executionTimeMs ??
                    session.stats
                      .totalLatencyMs) != null
                    ? `${
                        result?.executionTimeMs ??
                        session.stats
                          .totalLatencyMs
                      } ms`
                    : '—'}
                </p>
              </div>

              <div
                className={css({
                  p: '3',

                  bg: '#fafafa',

                  border:
                    '1px solid #e4e4e7',

                  borderRadius: '8px',
                })}
              >
                <p
                  className={css({
                    color: '#71717a',

                    fontWeight: '600',
                  })}
                >
                  Model Decision Adapter
                </p>

                <p
                  className={css({
                    mt: '1',

                    color: '#18181b',

                    fontSize: 'base',

                    fontWeight: '700',

                    textTransform: 'uppercase',
                  })}
                >
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