import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { css } from '../styled-system/css'
import {
  Filter,
  Table,
  GitBranch,
  Layers,
  Database,
  Clock,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Bookmark,
  Zap,
} from 'lucide-react'

/**
 * Configuration for the START node (the root state carries no action).
 */
const START_CONFIG = {
  label: 'START',
  Icon: Database,
  badgeBg: 'teal.50',
  badgeColor: 'teal.700',
  badgeBorder: 'teal.200',
}

/**
 * Returns configuration (label, icon, badge color) based on action type.
 */
function getActionConfig(action) {
  const norm = (action || '').toUpperCase()
  if (norm.includes('FILTER')) {
    return {
      label: norm.replace('ADD_', ''),
      Icon: Filter,
      badgeBg: 'purple.50',
      badgeColor: 'purple.700',
      badgeBorder: 'purple.200',
    }
  }
  if (norm.includes('JOIN')) {
    return {
      label: norm.replace('ADD_', ''),
      Icon: GitBranch,
      badgeBg: 'sky.50',
      badgeColor: 'sky.700',
      badgeBorder: 'sky.200',
    }
  }
  if (norm.includes('TABLE')) {
    return {
      label: norm.replace('ADD_', 'SELECT_'),
      Icon: Table,
      badgeBg: 'teal.50',
      badgeColor: 'teal.700',
      badgeBorder: 'teal.200',
    }
  }
  if (norm.includes('COLUMN')) {
    return {
      label: norm.replace('ADD_', 'SELECT_'),
      Icon: Layers,
      badgeBg: 'blue.50',
      badgeColor: 'blue.700',
      badgeBorder: 'blue.200',
    }
  }
  if (norm.includes('GROUP') || norm.includes('HAVING')) {
    return {
      label: norm.includes('HAVING') ? 'HAVING' : 'GROUP_BY',
      Icon: Layers,
      badgeBg: 'amber.50',
      badgeColor: 'amber.800',
      badgeBorder: 'amber.200',
    }
  }
  if (norm.includes('EXECUTE') || norm.includes('FINISH')) {
    return {
      label: 'FINISH',
      Icon: Zap,
      badgeBg: 'emerald.50',
      badgeColor: 'emerald.700',
      badgeBorder: 'emerald.200',
    }
  }
  return {
    label: norm || 'ACTION',
    Icon: Layers,
    badgeBg: 'gray.100',
    badgeColor: 'gray.700',
    badgeBorder: 'gray.200',
  }
}

/**
 * Formats structured or primitive action parameters for clean display.
 */
function formatActionParams(params) {
  if (params == null || params === '') return 'None'
  if (typeof params === 'string') return params
  if (typeof params === 'object') {
    if (params.column && params.operator && params.value !== undefined) {
      return `${params.table ? params.table + '.' : ''}${params.column} ${params.operator} ${params.value}`
    }
    if (params.table && params.left_on && params.right_on) {
      return `${params.table} (${params.left_on} = ${params.right_on})`
    }
    if (params.table && !params.column) {
      return `table: ${params.table}`
    }
    if (params.column) {
      return `${params.table ? params.table + '.' : ''}${params.column}`
    }
    if (params.limit !== undefined) {
      return `LIMIT ${params.limit}`
    }
    try {
      return Object.entries(params)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
    } catch {
      return JSON.stringify(params)
    }
  }
  return String(params)
}

function QueryActionNode({ data, selected }) {
  // The root state carries no action type; render it as a distinct START card.
  const isStart = !data.action && !data.action_type
  const actionConfig = isStart ? START_CONFIG : getActionConfig(data.action || data.action_type || 'ACTION')
  const ActionIcon = actionConfig.Icon

  const rawStatus = (data.status || 'SUCCESS').toUpperCase()

  // Graceful declines (INSUFFICIENT_INFO / SCHEMA_MISSING / ABORT_QUERY) arrive
  // with status='failed' but carry NO failure object — the reason lives in the
  // action params. Distinguish them from hard validation/SQL failures so they
  // render as amber "declined" nodes, never red.
  const DECLINE_TYPES = ['INSUFFICIENT_INFO', 'SCHEMA_MISSING', 'ABORT_QUERY']
  const isDeclined = Boolean(data.action) && DECLINE_TYPES.includes(String(data.action))
  const declineReason = data.params?.reason ?? data.parameters?.reason ?? null

  const isFailed = rawStatus === 'FAILED' && !isDeclined
  const isCompleted = rawStatus === 'SUCCESS' || rawStatus === 'COMPLETED'
  const isActive = rawStatus === 'ACTIVE' || rawStatus === 'NEW'
  const isInactive = data.isActiveBranch === false || data.is_active_branch === false

  const checkpointId = data.checkpointId || data.checkpoint_id
  const hasCheckpoint = Boolean(checkpointId)
  const isRecoveryBranch = Boolean(
    data.clarification ||
    (data.branch_id && data.branch_id.includes('branch') && data.branch_id !== 'main' && !isFailed)
  )

  // Visual status border determination according to spec:
  // Green for success, Amber for graceful declines/checkpoints, Red for
  // validation/SQL failure, Blue for recovery branches.
  let borderColor = '#22c55e' // Green (success default)
  let statusBadgeBg = 'green.50'
  let statusBadgeColor = 'green.700'
  let statusBadgeText = isCompleted ? 'Completed' : rawStatus
  let borderStyle = 'solid'

  if (isDeclined) {
    borderColor = '#f59e0b' // Amber (graceful decline)
    statusBadgeBg = 'amber.50'
    statusBadgeColor = 'amber.800'
    statusBadgeText = 'Declined'
    borderStyle = 'dashed'
  } else if (isFailed) {
    borderColor = '#ef4444' // Red (failure)
    statusBadgeBg = 'red.50'
    statusBadgeColor = 'red.700'
    statusBadgeText = 'Failed'
  } else if (hasCheckpoint) {
    borderColor = '#f59e0b' // Amber (checkpoint)
  } else if (isRecoveryBranch) {
    borderColor = '#3b82f6' // Blue (recovery branch)
  } else if (isActive) {
    borderColor = '#3b82f6'
    statusBadgeBg = 'blue.50'
    statusBadgeColor = 'blue.700'
    statusBadgeText = 'Active'
  }

  if (isInactive && !selected) {
    borderColor = isDeclined ? '#fbbf24' : isFailed ? '#f87171' : '#9ca3af'
    borderStyle = 'dashed'
  }

  // Parameter string. The start node shows the original request instead of an
  // empty params box.
  const paramDisplay = isStart
    ? (data.request?.trim() || '—')
    : formatActionParams(data.params ?? data.parameters)

  // Confidence %
  const rawConfidence = data.confidence
  let confidenceDisplay = null
  let confidenceVal = null
  if (rawConfidence != null) {
    confidenceVal = rawConfidence <= 1 ? Math.round(rawConfidence * 100) : Math.round(rawConfidence)
    confidenceDisplay = `${confidenceVal}%`
  }

  // Rows produced
  const rowCount = data.row_count ?? data.rows_produced ?? data.preview?.row_count ?? null
  const rowsDisplay = rowCount != null ? `${rowCount} rows` : null

  // Execution time
  const execTime = data.execution_time_ms ?? data.execution_time ?? data.preview?.execution_time_ms ?? null
  const timeDisplay = execTime != null ? `${execTime} ms` : null

  return (
    <div
      className={css({
        position: 'relative',
        width: '240px',
        borderRadius: '10px',
        background: isInactive ? '#fafafa' : 'white',
        borderWidth: '2px',
        borderStyle: borderStyle,
        borderColor: borderColor,
        boxShadow: selected
          ? '0 0 0 3px #3b82f6, 0 8px 16px -2px rgba(59, 130, 246, 0.2)'
          : isDeclined
            ? '0 2px 8px rgba(245, 158, 11, 0.18)'
            : isFailed
              ? '0 2px 8px rgba(239, 68, 68, 0.15)'
              : '0 2px 8px rgba(0, 0, 0, 0.06)',
        opacity: isInactive ? 0.72 : 1,
        transition: 'all 0.15s ease',
        cursor: 'pointer',
        padding: '12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        _hover: {
          boxShadow: selected
            ? '0 0 0 3px #3b82f6, 0 10px 20px -2px rgba(59, 130, 246, 0.25)'
            : '0 4px 12px rgba(0, 0, 0, 0.12)',
        },
      })}
    >
      {/* Top Handle: Incoming edge from parent state */}
      <Handle
        type="target"
        position={Position.Top}
        className={css({
          width: '10px !important',
          height: '10px !important',
          background: 'white !important',
          borderWidth: '2px !important',
          borderStyle: 'solid !important',
          borderColor: `${borderColor} !important`,
          borderRadius: '50% !important',
          top: '-6px !important',
          transition: 'transform 0.15s ease',
          _hover: {
            transform: 'scale(1.3)',
          },
        })}
      />

      {/* Checkpoint Badge Tag (pinned to top right when set) */}
      {hasCheckpoint && (
        <div
          title={`Checkpoint pinned: ${checkpointId}`}
          className={css({
            position: 'absolute',
            top: '-11px',
            right: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            padding: '2px 7px',
            borderRadius: '9999px',
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            color: '#92400e',
            fontSize: '10px',
            fontWeight: '700',
            letterSpacing: '0.02em',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
          })}
        >
          <Bookmark size={11} className={css({ fill: '#f59e0b', color: '#f59e0b' })} />
          <span>{checkpointId}</span>
        </div>
      )}

      {/* Header: Action Type & Status Badge */}
      <div
        className={css({
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '2',
        })}
      >
        {/* Action Type Badge */}
        <div
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '1.5',
            padding: '3px 7px',
            borderRadius: '6px',
            bg: actionConfig.badgeBg,
            color: actionConfig.badgeColor,
            border: '1px solid',
            borderColor: actionConfig.badgeBorder,
            fontSize: '11px',
            fontWeight: '700',
            letterSpacing: '0.03em',
          })}
        >
          <ActionIcon size={12} />
          <span>{actionConfig.label}</span>
        </div>

        {/* Status Pill */}
        <div
          className={css({
            display: 'inline-flex',
            alignItems: 'center',
            gap: '1',
            padding: '2px 6px',
            borderRadius: '9999px',
            bg: statusBadgeBg,
            color: statusBadgeColor,
            fontSize: '10px',
            fontWeight: '600',
          })}
        >
          {isDeclined ? (
            <AlertTriangle size={10} />
          ) : isFailed ? (
            <AlertCircle size={10} />
          ) : isCompleted ? (
            <CheckCircle2 size={10} />
          ) : (
            <span
              className={css({
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                bg: 'blue.500',
              })}
            />
          )}
          <span>{statusBadgeText}</span>
        </div>
      </div>

      {/* Parameters Preview Box */}
      <div
        title={paramDisplay}
        className={css({
          padding: '6px 8px',
          borderRadius: '6px',
          bg: isInactive ? 'gray.100' : 'gray.50',
          border: '1px solid',
          borderColor: 'gray.200',
          fontFamily: 'monospace',
          fontSize: '12px',
          fontWeight: '600',
          color: isInactive ? 'gray.600' : 'gray.800',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        {paramDisplay}
      </div>

      {/* Decline Reason Callout — graceful agent decline (amber) */}
      {isDeclined && declineReason && (
        <div
          title={declineReason}
          className={css({
            padding: '4px 6px',
            borderRadius: '4px',
            bg: 'amber.50',
            border: '1px solid',
            borderColor: 'amber.200',
            color: 'amber.800',
            fontSize: '10px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          <AlertTriangle size={11} className={css({ flexShrink: 0 })} />
          <span className={css({ overflow: 'hidden', textOverflow: 'ellipsis' })}>
            {declineReason}
          </span>
        </div>
      )}

      {/* Failure Reason Callout */}
      {isFailed && data.failure_reason && (
        <div
          title={data.failure_reason}
          className={css({
            padding: '4px 6px',
            borderRadius: '4px',
            bg: 'red.50',
            border: '1px solid',
            borderColor: 'red.200',
            color: 'red.700',
            fontSize: '10px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          <AlertCircle size={11} className={css({ flexShrink: 0 })} />
          <span className={css({ overflow: 'hidden', textOverflow: 'ellipsis' })}>
            {data.failure_reason}
          </span>
        </div>
      )}

      {/* Clarification / Recovery Branch Callout */}
      {data.clarification && (
        <div
          title={data.clarification}
          className={css({
            padding: '4px 6px',
            borderRadius: '4px',
            bg: 'blue.50',
            border: '1px solid',
            borderColor: 'blue.200',
            color: 'blue.700',
            fontSize: '10px',
            fontWeight: '500',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          })}
        >
          <GitBranch size={11} className={css({ flexShrink: 0 })} />
          <span className={css({ overflow: 'hidden', textOverflow: 'ellipsis' })}>
            {data.clarification}
          </span>
        </div>
      )}

      {/* Node Metrics Bar: Confidence, Rows Produced, Execution Time */}
      <div
        className={css({
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1',
          paddingTop: '6px',
          borderTopWidth: '1px',
          borderColor: 'gray.100',
          fontSize: '10px',
          color: 'gray.600',
        })}
      >
        {/* Confidence */}
        <div
          title="Decision Confidence"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
          })}
        >
          <span className={css({ fontSize: '9px', color: 'gray.400', textTransform: 'uppercase' })}>
            Conf
          </span>
          <span
            className={css({
              fontWeight: '600',
              color:
                confidenceVal == null
                  ? 'gray.500'
                  : confidenceVal >= 90
                    ? 'green.700'
                    : confidenceVal >= 70
                      ? 'amber.700'
                      : 'red.700',
            })}
          >
            {confidenceDisplay || '—'}
          </span>
        </div>

        {/* Rows Produced */}
        <div
          title="Rows Produced"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          })}
        >
          <span className={css({ fontSize: '9px', color: 'gray.400', textTransform: 'uppercase' })}>
            Rows
          </span>
          <span
            className={css({
              fontWeight: '600',
              color: 'gray.800',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
            })}
          >
            <Database size={9} className={css({ color: 'gray.400' })} />
            {rowsDisplay || '—'}
          </span>
        </div>

        {/* Execution Time */}
        <div
          title="Execution Latency"
          className={css({
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
          })}
        >
          <span className={css({ fontSize: '9px', color: 'gray.400', textTransform: 'uppercase' })}>
            Time
          </span>
          <span
            className={css({
              fontWeight: '600',
              color: 'gray.800',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
            })}
          >
            <Clock size={9} className={css({ color: 'gray.400' })} />
            {timeDisplay || '—'}
          </span>
        </div>
      </div>

      {/* Bottom Handle: Outgoing edge to child states */}
      <Handle
        type="source"
        position={Position.Bottom}
        className={css({
          width: '10px !important',
          height: '10px !important',
          background: 'white !important',
          borderWidth: '2px !important',
          borderStyle: 'solid !important',
          borderColor: `${borderColor} !important`,
          borderRadius: '50% !important',
          bottom: '-6px !important',
          transition: 'transform 0.15s ease',
          _hover: {
            transform: 'scale(1.3)',
          },
        })}
      />

      {/* Right Handle: Outgoing branching / recovery path */}
      <Handle
        type="source"
        id="branch"
        position={Position.Right}
        className={css({
          width: '8px !important',
          height: '8px !important',
          background: 'white !important',
          borderWidth: '2px !important',
          borderStyle: 'solid !important',
          borderColor: '#3b82f6 !important',
          borderRadius: '50% !important',
          right: '-5px !important',
          transition: 'transform 0.15s ease',
          _hover: {
            transform: 'scale(1.3)',
          },
        })}
      />
    </div>
  )
}

export default memo(QueryActionNode)
