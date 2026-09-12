import React from 'react'
import { Text, Box } from 'ink'
import type { Block } from '../hooks.js'
import { renderMarkdownPlain } from '../markdown.js'

const MAX_TOOL_OUTPUT = 6

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            {'> '}
            {block.text}
          </Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Text>{renderMarkdownPlain(block.text)}</Text>
        </Box>
      )
    case 'tool':
      return (
        <Box flexDirection="column">
          <Text color="magenta">
            ● <Text bold>{block.name}</Text> <Text dimColor>{block.desc}</Text>
          </Text>
          {block.output && (
            <Text color={block.ok === false ? 'red' : 'green'}>
              {'  '}
              {block.ok === false ? '✗ ' : '✓ '}
              {truncateLines(block.output, MAX_TOOL_OUTPUT)}
            </Text>
          )}
        </Box>
      )
    case 'notice':
      return (
        <Text color="yellow" dimColor>
          ⚠ {block.text}
        </Text>
      )
    case 'error':
      return (
        <Text color="red">✗ {block.text}</Text>
      )
  }
}

function truncateLines(s: string, max: number): string {
  const lines = s.split('\n')
  if (lines.length <= max) return s.slice(0, 300)
  return lines.slice(0, max).join('\n') + ` …(${lines.length - max} baris lagi)`
}
