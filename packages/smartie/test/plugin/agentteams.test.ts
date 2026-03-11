import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { ToolRegistry } from "../../src/tool/registry"

const env = { ...process.env }

const ctx = {
  sessionID: "ses-team",
  messageID: "msg-team",
  callID: "call-team",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

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
  const count = path.join(tmp.path, "gt.count")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(bin, { recursive: true })
  await Bun.write(
    gt,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$GT_LOG\"",
      "if [[ \"${1:-}\" == \"convoy\" && \"${2:-}\" == \"create\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"convoy\" ]]; then",
      "    echo 'convoy failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'hq-team.1'",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"bead\" && \"${2:-}\" == \"create\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"bead\" ]]; then",
      "    echo 'bead failed' >&2",
      "    exit 1",
      "  fi",
      "  n=$(cat \"$GT_COUNT\" 2>/dev/null || echo 0)",
      "  n=$((n+1))",
      "  printf '%s' \"$n\" > \"$GT_COUNT\"",
      "  echo \"bd-team.$n\"",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"mayor\" && \"${2:-}\" == \"dispatch\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"mayor\" ]]; then",
      "    echo 'mayor unavailable' >&2",
      "    exit 1",
      "  fi",
      "  echo 'dispatch ok'",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"prime\" ]]; then",
      "  echo 'prime'",
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  )
  await fs.chmod(gt, 0o755)
  process.env.HOME = home
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
  process.env.GT_LOG = log
  process.env.GT_COUNT = count
  return { dir: tmp.path, log, [Symbol.asyncDispose]: tmp[Symbol.asyncDispose].bind(tmp) }
}

async function lines(file: string) {
  return (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean)
}

async function teamTool() {
  const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
  const match = tools.find((item) => item.id === "agent_team_create")
  expect(match).toBeDefined()
  return match!
}

describe("plugin.agentteams", () => {
  test("SMARTIE_AGENT_TEAMS=0 never exposes team creation", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "0"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("agent_team_create")
      },
    })
  })

  test("SMARTIE_AGENT_TEAMS=1 can create convoy and beads then dispatch", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Refactor the parser stack",
            reason: "Independent parser modules can be split safely",
            tasks: [
              {
                description: "Refactor lexer",
                acceptance: "Lexer changes compile and existing lexer tests pass",
                targets: ["src/lexer.ts", "test/lexer.test.ts"],
              },
              {
                description: "Refactor parser",
                acceptance: "Parser changes compile and parser tests pass",
                targets: ["src/parser.ts", "test/parser.test.ts"],
              },
            ],
          },
          ctx as any,
        )

        const out = await lines(fx.log)
        expect(out[0]).toBe("convoy create --session ses-team Refactor the parser stack")
        expect(out[1]).toContain("bead create --convoy hq-team.1")
        expect(out[2]).toContain("bead create --convoy hq-team.1")
        expect(out[3]).toBe("mayor dispatch --convoy hq-team.1")
        expect(result.output).toContain("Created Agent Team convoy hq-team.1.")
        expect(result.output).toContain("Beads: bd-team.1, bd-team.2")
        expect(result.output).toContain("Dispatched convoy hq-team.1 to Mayor.")
      },
    })
  })

  test("convoy creation failure falls back to single-session execution", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "convoy"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          ctx as any,
        )
        expect(result.output).toContain("Agent Teams fallback: convoy creation failed.")
        expect(result.output).toContain("Continue in the current session")
      },
    })
  })

  test("bead creation failure falls back to single-session execution", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "bead"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          ctx as any,
        )
        const out = await lines(fx.log)
        expect(out).toEqual([
          "convoy create --session ses-team Split the migration work",
          "bead create --convoy hq-team.1 --description One --acceptance Done --targets a.ts",
        ])
        expect(result.output).toContain("Agent Teams fallback: bead creation failed.")
      },
    })
  })

  test("mayor dispatch failure falls back to single-session execution", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "mayor"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          ctx as any,
        )
        const out = await lines(fx.log)
        expect(out[2]).toBe("mayor dispatch --convoy hq-team.1")
        expect(result.output).toContain("Agent Teams fallback: mayor dispatch failed.")
        expect(result.output).toContain("Continue in the current session")
      },
    })
  })

  test("adds prompt guidance for explicit and model-proposed team creation when enabled", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const out = { system: [] as string[] }
        await Plugin.trigger("experimental.chat.system.transform", { model: { providerID: "test", api: { id: "test" } } as any }, out)
        const text = out.system.join("\n")
        expect(text).toContain("If the user explicitly asks to create an agent team")
        expect(text).toContain("You may also propose and use agent_team_create on your own")
      },
    })
  })
})
