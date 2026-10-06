import { Handle, Position } from '@xyflow/react'
import { css } from '../styled-system/css'

export default function TraceNode({ data, selected }) {
  const isFailed = data.status === 'FAILED'
  const isInactive = data.isActiveBranch === false
  const hasCheckpoint = Boolean(data.checkpointId)

  return (
    <div
      className={css({
        position: 'relative',
        minWidth: '160px',
        padding: '12px 16px',
        background: isInactive ? 'gray.100' : 'white',

        borderWidth: '2px',
        borderStyle: isInactive ? 'dashed' : 'solid',
borderColor: selected
  ? 'blue.500'
  : isInactive
    ? 'gray.400'
    : isFailed
      ? 'red.500'
      : 'green.500',

      boxShadow: selected ? '0 0 0 2px #3b82f6' : 'none',

        outlineWidth: isInactive && isFailed ? '1px' : '0',
        outlineStyle: 'solid',
        outlineColor: 'red.500',
        outlineOffset: '2px',

        borderRadius: '8px',
        color: isInactive ? 'gray.500' : 'gray.900',
      })}
    >
      <Handle type="target" position={Position.Top} />

      {hasCheckpoint && (
        <span
          title="Checkpoint"
          className={css({
            position: 'absolute',
            top: '-10px',
            right: '8px',
            color: 'purple.600',
            background: 'white',
            fontSize: '16px',
          })}
        >
          ◆
        </span>
      )}

      <div
        className={css({
          fontSize: '12px',
          fontWeight: '700',
        })}
      >
        {data.action}
      </div>

      <div
        className={css({
          fontSize: '12px',
          marginTop: '4px',
        })}
      >
        {data.params}
      </div>

      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}