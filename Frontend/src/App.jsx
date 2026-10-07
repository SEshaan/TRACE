import { useEffect, useMemo, useState } from 'react'
import { css } from '../styled-system/css'
import '../styled-system/styles.css'
import { Button } from '@/components/ui'
import FlowTest from './flowTest'
import { activeSession, queryCatalog } from './mockData'

function App() {
  const [dbs] = useState(queryCatalog)
  const [openDbId, setOpenDbId] = useState(activeSession.databaseId)
  const [openQueryId, setOpenQueryId] = useState(activeSession.queryId)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [drawerTab, setDrawerTab] = useState('final-sql')

  const activeDb = useMemo(
    () => dbs.find((db) => db.id === openDbId) ?? dbs[0],
    [dbs, openDbId],
  )

  const activeQuery = useMemo(
    () =>
      activeDb.queries.find((query) => query.id === openQueryId) ?? activeDb.queries[0],
    [activeDb, openQueryId],
  )

  useEffect(() => {
    if (!activeQuery.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(activeQuery.nodes[0]?.id ?? null)
    }
  }, [activeQuery, selectedNodeId])

  const selectedNode = useMemo(
    () => activeQuery.nodes.find((node) => node.id === selectedNodeId) ?? activeQuery.nodes[0],
    [activeQuery, selectedNodeId],
  )

  const finalSql = activeQuery.nodes[activeQuery.nodes.length - 1]?.sql ?? ''

  return (
    <main
      className={css({
        display: 'grid',
        gridTemplateColumns: { base: '1fr', lg: '220px minmax(0, 1fr) 280px' },
        gridTemplateRows: { base: 'auto auto auto auto', lg: '1fr 180px' },
        minH: '100vh',
        bg: 'gray.50',
        color: 'gray.900',
      })}
    >
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
          <p className={css({ fontSize: 'sm', color: 'gray.500' })}>
            TRACE
          </p>

          <h1 className={css({ fontSize: 'xl', fontWeight: 'bold' })}>
            Explorer
          </h1>
        </div>

        <input
          className={css({
            w: 'full',
            h: '10',
            px: '3',
            borderWidth: '1px',
            borderColor: 'gray.300',
            borderRadius: 'md',
            bg: 'white',
          })}
          placeholder="Search queries"
          aria-label="Search queries"
        />

        <div className={css({ display: 'flex', gap: '2' })}>
          <Button size="sm" variant="outline">
            All
          </Button>

          <Button size="sm" variant="outline">
            Success
          </Button>

          <Button size="sm" variant="outline">
            Failed
          </Button>
        </div>

        <Button variant="outline">
          + New query
        </Button>

        <div
          className={css({
            display: 'grid',
            gap: '2',
            fontSize: 'sm',
          })}
        >
          {dbs.map((db) => (
            <div key={db.id}>
              <strong>□ {db.name}</strong>
              {db.queries.map((query) => (
                <span
                  key={query.id}
                  className={css({
                    display: 'block',
                    pl: '4',
                    color: query.status === 'failed' ? 'red.700' : 'green.700',
                    cursor: 'pointer',
                    mt: '1',
                  })}
                  onClick={() => {
                    setOpenDbId(db.id)
                    setOpenQueryId(query.id)
                    setSelectedNodeId(query.nodes[0]?.id ?? null)
                  }}
                >
                  ● {query.title}
                </span>
              ))}
            </div>
          ))}
        </div>

        <Button variant="outline" mt="auto">
          + Add database
        </Button>
      </aside>

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
              <p className={css({ fontSize: 'sm', color: 'gray.500' })}>
                {activeDb.name}
              </p>

              <h2
                className={css({
                  fontSize: 'lg',
                  fontWeight: 'semibold',
                })}
              >
                {activeQuery.title}
              </h2>
            </div>

            <span
              className={css({
                color: activeQuery.status === 'failed' ? 'red.700' : 'green.700',
                fontSize: 'sm',
                fontWeight: 'medium',
              })}
            >
              {activeQuery.status === 'failed' ? 'Failed' : 'Success'}
            </span>
          </div>

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
              })}
              defaultValue={activeQuery.request}
              aria-label="Query request"
            />

            <Button>
              Run
            </Button>
          </div>
        </header>

        <div
          className={css({
            minH: '0',
            overflow: 'hidden',
            position: 'relative',
          })}
        >
          <FlowTest
            nodes={activeQuery.nodes}
            onSelectNode={(node) => setSelectedNodeId(node.id)}
            selectedNodeId={selectedNodeId}
          />
        </div>
      </section>

      <aside
        className={css({
          p: '4',
          bg: 'white',
          borderLeftWidth: { lg: '1px' },
          borderColor: 'gray.200',
          overflowY: 'auto',
        })}
      >
        <p className={css({ fontSize: 'sm', color: 'gray.500' })}>
          Node details
        </p>

        {selectedNode ? (
          <div className={css({ mt: '2', display: 'grid', gap: '3' })}>
            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Action
              </p>

              <h2
                className={css({
                  fontSize: 'lg',
                  fontWeight: 'semibold',
                })}
              >
                {selectedNode.action}
              </h2>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Parameters
              </p>

              <p className={css({ fontSize: 'sm' })}>
                {selectedNode.params}
              </p>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Status
              </p>

              <p
                className={css({
                  fontSize: 'sm',
                  color:
                    selectedNode.status === 'FAILED'
                      ? 'red.700'
                      : 'green.700',
                })}
              >
                {selectedNode.status}
              </p>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Confidence
              </p>

              <p className={css({ fontSize: 'sm' })}>
                {Math.round(selectedNode.confidence * 100)}%
              </p>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Checkpoint
              </p>

              <p className={css({ fontSize: 'sm' })}>
                {selectedNode.checkpoint_id || 'None'}
              </p>
            </div>

            <div>
              <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                Time
              </p>

              <p className={css({ fontSize: 'sm' })}>
                {selectedNode.created_at}
              </p>
            </div>

            {selectedNode.failure_reason && (
              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Failure reason
                </p>

                <p
                  className={css({
                    fontSize: 'sm',
                    color: 'red.700',
                    fontWeight: 'medium',
                  })}
                >
                  {selectedNode.failure_reason}
                </p>
              </div>
            )}

            {selectedNode.clarification && (
              <div>
                <p className={css({ fontSize: 'xs', color: 'gray.500' })}>
                  Clarification
                </p>

                <p className={css({ fontSize: 'sm' })}>
                  {selectedNode.clarification}
                </p>
              </div>
            )}
          </div>
        ) : (
          <>
            <h2
              className={css({
                mt: '1',
                fontSize: 'lg',
                fontWeight: 'semibold',
              })}
            >
              Select a node
            </h2>

            <p
              className={css({
                mt: '2',
                fontSize: 'sm',
                color: 'gray.600',
              })}
            >
              Details for the selected query action will appear here.
            </p>
          </>
        )}
      </aside>

      <section
        className={css({
          gridColumn: { lg: '2 / 4' },
          p: '4',
          bg: 'white',
          borderTopWidth: '1px',
          borderColor: 'gray.200',
        })}
      >
        <div
          className={css({
            display: 'flex',
            gap: '5',
            borderBottomWidth: '1px',
            borderColor: 'gray.200',
          })}
        >
          <strong
            className={css({
              pb: '2',
              borderBottomWidth: '2px',
              borderColor: 'blue.600',
            })}
            onClick={() => setDrawerTab('final-sql')}
          >
            Final SQL
          </strong>

          <span className={css({ color: 'gray.500' })} onClick={() => setDrawerTab('results')}>
            Results
          </span>

          <span className={css({ color: 'gray.500' })} onClick={() => setDrawerTab('summary')}>
            Summary
          </span>
        </div>

        {drawerTab === 'final-sql' && (
          <pre
            className={css({
              mt: '3',
              whiteSpace: 'pre-wrap',
              fontSize: 'sm',
              color: 'gray.700',
            })}
          >
            {finalSql}
          </pre>
        )}

        {drawerTab === 'results' && (
          <pre
            className={css({
              mt: '3',
              whiteSpace: 'pre-wrap',
              fontSize: 'sm',
              color: 'gray.700',
            })}
          >
            {JSON.stringify(activeQuery.rows, null, 2)}
          </pre>
        )}

        {drawerTab === 'summary' && (
          <pre
            className={css({
              mt: '3',
              whiteSpace: 'pre-wrap',
              fontSize: 'sm',
              color: 'gray.700',
            })}
          >
            {JSON.stringify({
              status: activeQuery.status,
              updated: activeQuery.updated,
              ms: activeQuery.ms,
            }, null, 2)}
          </pre>
        )}
      </section>
    </main>
  )
}

export default App