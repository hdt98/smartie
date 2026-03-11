import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"

const env = { ...process.env }

const ctx = {
  sessionID: "ses-mayor",
  messageID: "msg-mayor",
  callID: "call-mayor",
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

async function setup(opts?: { failCmd?: string; beads?: string[] }) {
  const tmp = await tmpdir()
  const home = path.join(tmp.path, "home")
  const bin = path.join(tmp.path, "bin")
  const gt = path.join(bin, "gt")
  const log = path.join(tmp.path, "gt.log")
  const count = path.join(tmp.path, "gt.count")
  const beadList = (opts?.beads ?? ["bd-m.1", "bd-m.2", "bd-m.3"]).join("\n")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(bin, { recursive: true })

  // Initialize a git repo so branch/worktree commands can work
  const { execSync } = await import("child_process")
  execSync("git init && git commit --allow-empty -m init", { cwd: tmp.path, stdio: "ignore" })

  await Bun.write(
    gt,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$*\" >> \"$GT_LOG\"",
      "",
      'if [[ "${1:-}" == "convoy" && "${2:-}" == "beads" ]]; then',
      `  if [[ "\${GT_FAIL:-}" == "convoy-beads" ]]; then`,
      "    echo 'convoy not found' >&2",
      "    exit 1",
      "  fi",
      `  printf '%s\\n' ${beadList.split("\n").map((b) => `"${b}"`).join(" ")}`,
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "sling" && "${2:-}" == "create" ]]; then',
      `  if [[ "\${GT_FAIL:-}" == "sling" ]]; then`,
      "    echo 'sling failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'sling ok'",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "bead" && "${2:-}" == "update" ]]; then',
      "  echo 'bead updated'",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "convoy" && "${2:-}" == "create" ]]; then',
      "  echo 'hq-team.1'",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "bead" && "${2:-}" == "create" ]]; then',
      "  n=$(cat \"$GT_COUNT\" 2>/dev/null || echo 0)",
      "  n=$((n+1))",
      "  printf '%s' \"$n\" > \"$GT_COUNT\"",
      "  echo \"bd-team.$n\"",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "mayor" && "${2:-}" == "dispatch" ]]; then',
      "  echo 'dispatch ok'",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "prime" ]]; then',
      "  echo 'prime'",
      "  exit 0",
      "fi",
      "",
      "exit 0",
      "",
    ].join("\n"),
  )
  await fs.chmod(gt, 0o755)
  process.env.HOME = home
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
  process.env.GT_LOG = log
  process.env.GT_COUNT = count
  // Enable agent teams so the AgentTeamsPlugin doesn't interfere
  process.env.SMARTIE_AGENT_TEAMS = "0"
  return { dir: tmp.path, log, [Symbol.asyncDispose]: tmp[Symbol.asyncDispose].bind(tmp) }
}

async function lines(file: string) {
  return (await fs.readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean)
}

async function dispatchTool() {
  const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
  const match = tools.find((item) => item.id === "mayor_dispatch")
  expect(match).toBeDefined()
  return match!
}

async function completeTool() {
  const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
  const match = tools.find((item) => item.id === "mayor_bead_complete")
  expect(match).toBeDefined()
  return match!
}

describe("plugin.mayordispatch", () => {
  test("dispatch creates branches and spawns polecats for 3 beads", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        const result = await tool.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const out = await lines(fx.log)
        // First call: convoy beads listing
        expect(out[0]).toBe("convoy beads hq-team.1")
        // Then 3 sling create calls (one per bead)
        const slingCalls = out.filter((l) => l.startsWith("sling create"))
        expect(slingCalls.length).toBe(3)
        expect(slingCalls[0]).toContain("--bead bd-m.1")
        expect(slingCalls[1]).toContain("--bead bd-m.2")
        expect(slingCalls[2]).toContain("--bead bd-m.3")

        expect(result.output).toContain("3 of 3 Polecats spawned")
      },
    })
  })

  test("spawned polecats have SMARTIE_AGENT_TEAMS=0", async () => {
    await using fx = await setup({ beads: ["bd-m.1"] })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        await tool.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const out = await lines(fx.log)
        const slingCall = out.find((l) => l.startsWith("sling create"))
        expect(slingCall).toBeDefined()
        expect(slingCall).toContain("SMARTIE_AGENT_TEAMS=0")
      },
    })
  })

  test("branch naming follows bead_<id> pattern", async () => {
    await using fx = await setup({ beads: ["bd-m.1"] })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        await tool.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const out = await lines(fx.log)
        const slingCall = out.find((l) => l.startsWith("sling create"))
        expect(slingCall).toContain("--branch bead_bd-m.1")
      },
    })
  })

  test("convoy beads listing failure reports error", async () => {
    process.env.GT_FAIL = "convoy-beads"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        const result = await tool.execute({ convoy_id: "hq-bad" }, ctx as any)

        expect(result.output).toContain("Dispatch failed")
        expect(result.output).toContain("could not list beads")
      },
    })
  })

  test("sling spawn failure marks bead as failed", async () => {
    process.env.GT_FAIL = "sling"
    await using fx = await setup({ beads: ["bd-m.1"] })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        const result = await tool.execute({ convoy_id: "hq-team.1" }, ctx as any)

        expect(result.output).toContain("0 of 1 Polecats spawned")
        expect(result.output).toContain("1 bead(s) failed to launch")

        // Verify bead was marked failed
        const out = await lines(fx.log)
        const updateCall = out.find((l) => l.startsWith("bead update"))
        expect(updateCall).toBeDefined()
        expect(updateCall).toContain("bd-m.1")
        expect(updateCall).toContain("--status failed")
      },
    })
  })

  test("bead completion marks done and reports progress", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        // First dispatch to set up state
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        // Then complete one bead
        const complete = await completeTool()
        const result = await complete.execute(
          { convoy_id: "hq-team.1", bead_id: "bd-m.1", success: true },
          ctx as any,
        )

        expect(result.output).toContain("1/3 complete")
        expect(result.output).toContain("bd-m.1 done")

        // Verify bead was marked closed
        const out = await lines(fx.log)
        const updateCalls = out.filter((l) => l.startsWith("bead update"))
        const closedCall = updateCalls.find((l) => l.includes("--status closed"))
        expect(closedCall).toBeDefined()
        expect(closedCall).toContain("bd-m.1")
      },
    })
  })

  test("failed polecat retries up to 3 times then marks failed", async () => {
    await using fx = await setup({ beads: ["bd-m.1"] })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const complete = await completeTool()

        // Fail attempt 2 (attempt 1 was the initial dispatch)
        const r1 = await complete.execute(
          { convoy_id: "hq-team.1", bead_id: "bd-m.1", success: false },
          ctx as any,
        )
        expect(r1.output).toContain("retrying (attempt 2/3)")

        // Fail attempt 3
        const r2 = await complete.execute(
          { convoy_id: "hq-team.1", bead_id: "bd-m.1", success: false },
          ctx as any,
        )
        expect(r2.output).toContain("retrying (attempt 3/3)")

        // Fail attempt 4 — should exhaust retries
        const r3 = await complete.execute(
          { convoy_id: "hq-team.1", bead_id: "bd-m.1", success: false },
          ctx as any,
        )
        expect(r3.output).toContain("exhausted 3 retries")
        expect(r3.output).toContain("marked failed")
      },
    })
  })

  test("unknown convoy returns error", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const complete = await completeTool()
        const result = await complete.execute(
          { convoy_id: "hq-unknown", bead_id: "bd-1", success: true },
          ctx as any,
        )
        expect(result.output).toContain("Unknown convoy")
      },
    })
  })
})
