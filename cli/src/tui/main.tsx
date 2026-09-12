import type { AgentRuntime } from '../agent/runtime.js'

/** Entry TUI Ink — hanya dipanggil di jalur TTY via dynamic import agar
 *  fallback non-TTY tidak pernah me-load react/ink. */
export async function startTui(rt: AgentRuntime, files: string[]): Promise<void> {
  const React = (await import('react')).default
  const { render } = await import('ink')
  const { App } = await import('./App.js')
  const instance = render(React.createElement(App, { rt, files }), { exitOnCtrlC: true })
  await instance.waitUntilExit()
}
