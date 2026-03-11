import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { materialize } from "../../src/plugin/gastown"
import { Instance } from "../../src/project/instance"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Session } from "../../src/session"
import { Plugin } from "../../src/plugin"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { SessionStatus } from "../../src/session/status"

const env = { ...process.env }

beforeEach(() => {
  process.env = { ...env }
})

afterEach(async () => {
  process.env = { ...env }
  await Instance.disposeAll()
})

async function setup() {
  const tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const bin = path.join(tmp.path, "bin")
  const gt = path.join(bin, "gt")
  const log = path.join(tmp.path, "gt.log")
  await fs.mkdir(path.join(home, ".gt"), { recursive: true })
  await fs.mkdir(bin, { recursive: true })
  await Bun.write(
    gt,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$GT_LOG\"",
      "case \"${1:-}\" in",
      "  prime)",
      "    echo 'prime context from gastown'",
      "    exit 0",
      "    ;;",
      "  tap)",
      "    if [[ \"${2:-}\" == \"guard\" && \"${3:-}\" == \"dangerous-command\" ]]; then",
      "      echo 'dangerous command denied' >&2",
      "      exit 2",
      "    fi",
      "    if [[ \"${2:-}\" == \"guard\" && \"${3:-}\" == \"broken-hook\" ]]; then",
      "      echo 'hook exploded' >&2",
      "      exit 1",
      "    fi",
      "    echo 'allowed' >&2",
      "    exit 0",
      "    ;;",
      "  signal)",
      "    exit 0",
      "    ;;",
      "  costs)",
      "    exit 0",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  )
  await fs.chmod(gt, 0o755)
  await Bun.write(
    path.join(home, ".gt", "hooks-base.json"),
    JSON.stringify(
      {
        SessionStart: [
          {
            matcher: "",
            hooks: [{ type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt prime --hook' }],
          },
        ],
        PreToolUse: [
          {
            matcher: "Bash(rm -rf /*)",
            hooks: [
              {
                type: "command",
                command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt tap guard dangerous-command',
              },
            ],
          },
          {
            matcher: "Bash(hook fail)",
            hooks: [
              {
                type: "command",
                command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt tap guard broken-hook',
              },
            ],
          },
        ],
        Stop: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt signal stop' },
              { type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt costs record' },
            ],
          },
        ],
      },
      null,
      2,
    ) + "\n",
  )
  process.env.HOME = home
  process.env.GT_LOG = log
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
  return { dir: tmp.path, log, [Symbol.asyncDispose]: tmp[Symbol.asyncDispose].bind(tmp) }
}

async function lines(file: string) {
  return (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean)
}

async function wait(file: string, expected: string[]) {
  for (let i = 0; i < 20; i++) {
    const out = await lines(file)
    if (expected.every((item) => out.includes(item))) return out
    await Bun.sleep(50)
  }
  return lines(file)
}

describe("plugin.gastown", () => {
  test("materializes claude-style settings.json from hooks-base", async () => {
    await using fx = await setup()
    const file = await materialize(fx.dir)
    const raw = JSON.parse(await fs.readFile(file, "utf8"))
    expect(raw).toEqual({
      hooks: {
        SessionStart: [{ type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt prime' }],
        PreToolUse: [
          {
            matcher: "Bash(rm -rf /*)",
            hooks: [
              {
                type: "command",
                command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt tap guard dangerous-command',
              },
            ],
          },
          {
            matcher: "Bash(hook fail)",
            hooks: [
              {
                type: "command",
                command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt tap guard broken-hook',
              },
            ],
          },
        ],
        Stop: [
          { type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt signal stop' },
          { type: "command", command: 'export PATH="$HOME/go/bin:$HOME/.local/bin:$PATH" && gt costs record' },
        ],
      },
    })
  })

  test("runs SessionStart prime and injects its output into system prompt", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      init: InstanceBootstrap,
      fn: async () => {
        const ses = await Session.create({})
        const out = { system: [] as string[] }
        await Plugin.trigger(
          "experimental.chat.system.transform",
          { sessionID: ses.id, model: { providerID: "test", api: { id: "test" } } as any },
          out,
        )
        expect(out.system.at(-1)).toBe("prime context from gastown")
        expect(await lines(fx.log)).toContain("prime")
      },
    })
  })

  test("blocks risky bash commands with deny semantics and surfaces allow/deny toasts", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      init: InstanceBootstrap,
      fn: async () => {
        const ses = await Session.create({})
        const seen: string[] = []
        const off = Bus.subscribe(TuiEvent.ToastShow, (evt) => {
          seen.push(`${evt.properties.variant}:${evt.properties.message}`)
        })

        const err = await Plugin.trigger(
          "tool.execute.before",
          { tool: "bash", sessionID: ses.id, callID: "call-risky" },
          { args: { command: "rm -rf /" } },
        ).catch((error) => error)

        expect(err).toBeInstanceOf(Error)
        expect(String(err)).toContain("Gastown deny")

        await Plugin.trigger(
          "tool.execute.before",
          { tool: "bash", sessionID: ses.id, callID: "call-safe" },
          { args: { command: "echo ok" } },
        )

        off()

        expect(seen.some((item) => item.includes("warning:Gastown deny: Bash(rm -rf /)"))).toBeTrue()
        expect(seen.some((item) => item.includes("info:Gastown allow: Bash(echo ok)"))).toBeTrue()
      },
    })
  })

  test("surfaces failing hooks through session.error", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      init: InstanceBootstrap,
      fn: async () => {
        const ses = await Session.create({})
        const seen: string[] = []
        const off = Bus.subscribe(Session.Event.Error, (evt) => {
          const error = evt.properties.error as any
          seen.push(error?.data?.message ?? String(error))
        })

        const err = await Plugin.trigger(
          "tool.execute.before",
          { tool: "bash", sessionID: ses.id, callID: "call-broken" },
          { args: { command: "hook fail" } },
        ).catch((error) => error)

        off()

        expect(err).toBeInstanceOf(Error)
        expect(String(err)).toContain("Gastown hook error")
        expect(seen).toEqual(["Gas Town PreToolUse failed: Bash(hook fail) (hook exploded)"])
      },
    })
  })

  test("runs Stop hooks when a busy session returns to idle", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      init: InstanceBootstrap,
      fn: async () => {
        const ses = await Session.create({})
        const hooks = await Plugin.list()
        for (const hook of hooks) {
          await hook.event?.({
            event: {
              type: SessionStatus.Event.Status.type,
              properties: {
                sessionID: ses.id,
                status: { type: "busy" },
              },
            },
          })
          await hook.event?.({
            event: {
              type: SessionStatus.Event.Status.type,
              properties: {
                sessionID: ses.id,
                status: { type: "idle" },
              },
            },
          })
        }
        const out = await wait(fx.log, ["signal stop", "costs record"])
        expect(out).toContain("signal stop")
        expect(out).toContain("costs record")
      },
    })
  })
})
