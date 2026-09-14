/**
 * Host implementation untuk Node.js (CLI & test suite).
 * App desktop TIDAK memakai file ini — ia menyediakan host via Tauri IPC.
 * FS interface async — Node di sini tetap sync di balik fs/promises.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { exec, execFile, spawn } from 'node:child_process'
import os from 'node:os'
import crypto from 'node:crypto'
import type { Host, HostExecOptions, HostProcess, HostSpawnOptions } from './host.js'

const fsImpl = {
  readFile(path: string, encoding?: string): Promise<string | Uint8Array> {
    return encoding
      ? fsp.readFile(path, encoding as 'utf8' | 'base64')
      : fsp.readFile(path).then((b) => new Uint8Array(b))
  },
  writeFile(path: string, data: string | Uint8Array, opts?: 'utf8' | { encoding?: string; mode?: number }): Promise<void> {
    return fsp.writeFile(path, data, opts as never)
  },
  stat: (path: string) => fsp.stat(path),
  readdir(path: string, opts?: { withFileTypes: true }): Promise<string[] | fs.Dirent[]> {
    return opts ? fsp.readdir(path, opts) : fsp.readdir(path)
  },
  mkdir: (path: string, opts?: { recursive?: boolean }) => fsp.mkdir(path, opts).then(() => undefined),
  exists: (path: string) => fsp.access(path).then(() => true, () => false),
  unlink: (path: string) => fsp.unlink(path),
  chmod: (path: string, mode: number) => fsp.chmod(path, mode),
}

export const nodeHost: Host = {
  fs: fsImpl as unknown as Host['fs'],

  crypto: {
    randomBytes: (n) => crypto.randomBytes(n),
    randomHex: (bytes) => crypto.randomBytes(bytes).toString('hex'),
    sha256hex: (data) => crypto.createHash('sha256').update(data).digest('hex'),
    sha1hex: (data) => crypto.createHash('sha1').update(data).digest('hex'),
  },

  homedir: () => os.homedir(),
  tmpdir: () => os.tmpdir(),
  cwd: () => process.cwd(),
  env: process.env,


  exec: {
    spawn: ((command: string, args: string[], opts?: HostSpawnOptions) =>
      spawn(command, args, opts as never) as unknown as HostProcess) as Host['exec']['spawn'],

    execFile: ((command: string, args: string[], opts?: HostExecOptions) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          command,
          args,
          {
            cwd: opts?.cwd,
            timeout: opts?.timeout,
            maxBuffer: opts?.maxBuffer,
            env: opts?.env as never,
          },
          (err, stdout, stderr) => {
            if (err) reject(new Error(String(stderr || err.message)))
            else resolve(String(stdout))
          }
        )
      })) as Host['exec']['execFile'],

    exec: ((command: string, opts?: HostExecOptions) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        exec(
          command,
          {
            cwd: opts?.cwd,
            timeout: opts?.timeout,
            maxBuffer: opts?.maxBuffer,
            env: opts?.env as never,
          },
          (err, stdout, stderr) => {
            let code = 0
            if (err) {
              const c = (err as NodeJS.ErrnoException & { code?: number | string }).code
              code = typeof c === 'number' ? c : (err as Error & { killed?: boolean }).killed ? 124 : 1
            }
            resolve({ code, stdout: String(stdout), stderr: String(stderr) })
          }
        )
      })) as Host['exec']['exec'],
  },
}