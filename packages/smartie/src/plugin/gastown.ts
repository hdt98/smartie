import fs from "fs/promises"
import os from "os"
import path from "path"
import { NamedError } from "@smartie-code/util/error"
import type { Plugin } from "@smartie-code/plugin"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Wildcard } from "@/util/wildcard"
import { Process } from "@/util/process"
import z from "zod"

type Cmd = {
  type: "command"
  command: string
}

type Match = {
  matcher?: string
  hooks: Cmd[]
}

type Base = Partial<{
  PreToolUse: Match[]
}>

type Settings = {
  hooks: {
    SessionStart: Cmd[]
    PreToolUse: Match[]
    Stop: Cmd[]
  }
}

type Out = {
  code: number
  stdout: string
  stderr: string
}

function home() {
  return process.env.HOME || os.homedir()
}

function binpath() {
  return [path.join(home(), "go", "bin"), path.join(home(), ".local", "bin"), process.env.PATH ?? ""].join(":")
}

function basefile() {
  return path.join(home(), ".gt", "hooks-base.json")
}

function prefix() {
  return 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && '
}

function sessionstart() {
  return { type: "command", command: `${prefix()}gt prime` } satisfies Cmd
}

function stop() {
  return [
    { type: "command", command: `${prefix()}gt signal stop` },
    { type: "command", command: `${prefix()}gt costs record` },
  ] satisfies Cmd[]
}

async function read(): Promise<Base> {
  const file = basefile()
  const text = await fs.readFile(file, "utf8").catch(() => "")
  if (!text) return { PreToolUse: [] }
  return JSON.parse(text) as Base
}

function flatten(list?: Match[]) {
  return (list ?? []).flatMap((item) => item.hooks ?? [])
}

export async function settings(): Promise<Settings> {
  const cfg = await read()
  return {
    hooks: {
      SessionStart: [sessionstart()],
      PreToolUse: (cfg.PreToolUse ?? []).map((item) => ({
        matcher: item.matcher ?? "*",
        hooks: item.hooks ?? [],
      })),
      Stop: stop(),
    },
  }
}

export async function materialize(dir: string) {
  const file = path.join(dir, ".claude", "settings.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(await settings(), null, 2) + "\n")
  return file
}

function render(tool: string, args: any) {
  if (tool === "bash" && typeof args?.command === "string") return `Bash(${args.command})`
  if (tool === "bash") return "Bash(*)"
  return `${tool}(${JSON.stringify(args ?? {})})`
}

async function sh(command: string, cwd: string): Promise<Out> {
  const shell = await fs
    .stat(process.env.SHELL || "")
    .then(() => process.env.SHELL!)
    .catch(() => "/bin/sh")
  const out = await Process.run([shell, "-lc", command], {
    cwd,
    env: {
      PATH: binpath(),
    },
    nothrow: true,
  })
  return {
    code: out.code,
    stdout: out.stdout.toString().trim(),
    stderr: out.stderr.toString().trim(),
  }
}

const HookError = BusEvent.define(
  "session.error",
  z.object({
    sessionID: z.string().optional(),
    error: z.any(),
  }),
)

async function status(title: string, message: string, variant: "info" | "success" | "warning" | "error") {
  await Bus.publish(TuiEvent.ToastShow, {
    title,
    message,
    variant,
  })
}

function text(out: Out) {
  return out.stderr || out.stdout || "Hook failed without output"
}

async function fail(sessionID: string | undefined, phase: string, message: string) {
  await Bus.publish(HookError, {
    sessionID,
    error: new NamedError.Unknown({ message: `Gas Town ${phase} failed: ${message}` }).toObject(),
  })
}

export const GasTownPlugin: Plugin = async (input) => {
  const started = new Map<string, Promise<string | undefined>>()
  const busy = new Set<string>()
  const stopped = new Set<string>()

  async function prime(sessionID: string) {
    const existing = started.get(sessionID)
    if (existing) return existing
    const task = (async () => {
      let parts: string[] = []
      const out = await sh(sessionstart().command, input.directory)
      if (out.code !== 0) {
        await fail(sessionID, "SessionStart", text(out))
        throw new Error(`Gastown hook error: SessionStart (${text(out)})`)
      }
      await status("Hook Status", "Gastown SessionStart: gt prime", "info")
      if (out.stdout) parts.push(out.stdout)
      return parts.filter(Boolean).join("\n").trim() || undefined
    })()
    started.set(sessionID, task)
    return task
  }

  async function signal(sessionID: string) {
    if (stopped.has(sessionID)) return
    stopped.add(sessionID)
    for (const hook of stop()) {
      const out = await sh(hook.command, input.directory)
      if (out.code !== 0) {
        await fail(sessionID, "Stop", text(out))
        throw new Error(`Gastown hook error: Stop (${text(out)})`)
      }
    }
    await status("Hook Status", "Gastown Stop: gt signal stop, gt costs record", "info")
  }

  return {
    async event(input) {
      const event = input.event
      if (event.type === "session.created") {
        void prime(event.properties.info.id).catch(() => undefined)
        return
      }
      if (event.type !== "session.status") return
      if (event.properties.status.type === "busy") {
        busy.add(event.properties.sessionID)
        stopped.delete(event.properties.sessionID)
        return
      }
      if (event.properties.status.type !== "idle") return
      if (!busy.has(event.properties.sessionID)) return
      busy.delete(event.properties.sessionID)
      void signal(event.properties.sessionID).catch(() => undefined)
    },
    async "experimental.chat.system.transform"(input, output) {
      if (!input.sessionID) return
      const result = await prime(input.sessionID)
      if (!result) return
      output.system.push(result)
    },
    async "tool.execute.before"(input, output) {
      const cfg = await read()
      const subject = render(input.tool, output.args)
      const hooks = (cfg.PreToolUse ?? []).filter((item) => Wildcard.match(subject, item.matcher ?? "*"))
      if (!hooks.length) {
        await status("Hook Status", `Gastown allow: ${subject}`, "info")
        return
      }
      for (const item of hooks) {
        for (const hook of item.hooks ?? []) {
          const out = await sh(hook.command, input.directory)
          if (out.code === 0) continue
          if (out.code === 2) {
            const message = `Gastown deny: ${subject} (${text(out)})`
            await status("Hook Status", message, "warning")
            throw new Error(message)
          }
          await fail(input.sessionID, "PreToolUse", `${subject} (${text(out)})`)
          throw new Error(`Gastown hook error: ${subject} (${text(out)})`)
        }
      }
      await status("Hook Status", `Gastown allow: ${subject}`, "success")
    },
    async "shell.env"(_input, output) {
      output.env.PATH = binpath()
    },
  }
}
