import React from 'react'
import { Text, Box } from 'ink'
import type { TodoItem } from '../../storage/todo.js'

const ICON: Record<TodoItem['status'], string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]',
}

const COLOR: Record<TodoItem['status'], string> = {
  pending: 'white',
  in_progress: 'yellow',
  completed: 'green',
  cancelled: 'gray',
}

/** Panel checklist live dari tool todo_write. */
export function TodoPanel({ items }: { items: TodoItem[] }) {
  if (items.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold dimColor>
        Todo
      </Text>
      {items.map((t, i) => (
        <Text key={i} color={COLOR[t.status]} strikethrough={t.status === 'cancelled'}>
          {ICON[t.status]} {t.content}
        </Text>
      ))}
    </Box>
  )
}
