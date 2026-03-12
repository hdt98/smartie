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
      'if [[ "${1:-}" == "rig" && "${2:-}" == "status" ]]; then',
      `  if [[ "\${GT_FAIL:-}" == "rig-status" ]]; then`,
      "    echo 'rig missing' >&2",
      "    exit 1",
      "  fi",
      "  echo 'rig status ok'",
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
      'if [[ "${1:-}" == "convoy" && "${2:-}" == "close" ]]; then',
      "  echo 'convoy closed'",
      "  exit 0",
      "fi",
      "",
      'if [[ "${1:-}" == "signal" && "${2:-}" == "convoy-complete" ]]; then',
      `  if [[ "\${GT_FAIL:-}" == "signal" ]]; then`,
      "    echo 'signal failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'signal sent'",
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

async function mergeTool() {
  const tools = await ToolRegistry.tools({ providerID: "test", modelID: "test" })
  const match = tools.find((item) => item.id === "mayor_convoy_merge")
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

  test("request context is inherited into teammate launch", async () => {
    await using fx = await setup({ beads: ["bd-m.1"] })
    const auth = path.join(fx.dir, "auth.json")
    await Bun.write(auth, "{}")
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        await tool.execute(
          {
            convoy_id: "hq-team.1",
            provider_id: "lead-provider",
            model_id: "lead-model",
            runtime: "plan",
            auth_path: auth,
          },
          ctx as any,
        )

        const out = await lines(fx.log)
        const slingCall = out.find((l) => l.startsWith("sling create"))
        expect(slingCall).toBeDefined()
        expect(slingCall).toContain("--cmd smartie run --model lead-provider/lead-model --agent plan")
        expect(slingCall).toContain("--env SMARTIE_LEAD_PROVIDER=lead-provider")
        expect(slingCall).toContain("--env SMARTIE_LEAD_MODEL=lead-model")
        expect(slingCall).toContain(`--env SMARTIE_AUTH_PATH=${auth}`)
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

  test("missing request rig rejects dispatch cleanly", async () => {
    process.env.GT_FAIL = "rig-status"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        const result = await tool.execute({ convoy_id: "hq-bad", rig: "smartie-rq-x", root: fx.dir }, ctx as any)
        expect(result.output).toContain("request rig smartie-rq-x is unavailable")
      },
    })
  })

  test("missing auth inheritance path rejects dispatch cleanly", async () => {
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await dispatchTool()
        const auth = path.join(fx.dir, "missing", "auth.json")
        const result = await tool.execute({ convoy_id: "hq-bad", auth_path: auth }, ctx as any)
        expect(result.output).toContain(`auth inheritance path not found at ${auth}`)
        const out = await lines(fx.log)
        expect(out.some((line) => line.startsWith("convoy beads"))).toBe(false)
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

async function gitExec(cmd: string, cwd: string) {
  const { execSync } = await import("child_process")
  return execSync(cmd, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@test" } }).toString().trim()
}

async function setupWithBranches(beadIds: string[], opts?: { conflict?: boolean }) {
  const fx = await setup({ beads: beadIds })

  // Create a file on main so branches can diverge
  await Bun.write(path.join(fx.dir, "base.txt"), "base\n")
  await gitExec("git add base.txt && git commit -m 'base file'", fx.dir)

  // Create bead branches with unique commits
  for (const id of beadIds) {
    const branch = `bead_${id}`
    await gitExec(`git checkout -b ${branch}`, fx.dir)
    if (opts?.conflict && id === beadIds[beadIds.length - 1]) {
      // Last bead writes to same file as first bead to cause conflict
      await Bun.write(path.join(fx.dir, `${beadIds[0]}.txt`), `conflict from ${id}\n`)
      await gitExec(`git add ${beadIds[0]}.txt && git commit -m '${id} conflict'`, fx.dir)
    } else {
      await Bun.write(path.join(fx.dir, `${id}.txt`), `work from ${id}\n`)
      await gitExec(`git add ${id}.txt && git commit -m '${id} work'`, fx.dir)
    }
    await gitExec("git checkout main", fx.dir)
  }

  return fx
}

describe("plugin.mayordispatch.merge (US13)", () => {
  test("3 beads complete, all merge cleanly", async () => {
    const beads = ["bd-m.1", "bd-m.2", "bd-m.3"]
    await using fx = await setupWithBranches(beads)
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        // Dispatch
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        // Complete all beads
        const complete = await completeTool()
        for (const id of beads) {
          await complete.execute({ convoy_id: "hq-team.1", bead_id: id, success: true }, ctx as any)
        }

        // Merge
        const merge = await mergeTool()
        const result = await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        expect(result.output).toContain("Merged: 3/3 beads")
        expect(result.output).toContain("Succeeded: bd-m.1, bd-m.2, bd-m.3")
        expect(result.output).not.toContain("Conflicts")
        expect(result.output).not.toContain("Failed")

        // Verify convoy close was called
        const out = await lines(fx.log)
        expect(out.some((l) => l.startsWith("convoy close hq-team.1"))).toBe(true)

        // Verify signal was sent
        expect(out.some((l) => l.startsWith("signal convoy-complete"))).toBe(true)
      },
    })
  })

  test("2 beads complete, 1 fails — partial success", async () => {
    const beads = ["bd-m.1", "bd-m.2", "bd-m.3"]
    await using fx = await setupWithBranches(beads)
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const complete = await completeTool()
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.1", success: true }, ctx as any)
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.2", success: true }, ctx as any)
        // Exhaust retries for bd-m.3
        for (let i = 0; i < 3; i++) {
          await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.3", success: false }, ctx as any)
        }

        const merge = await mergeTool()
        const result = await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        expect(result.output).toContain("Merged: 2/3 beads")
        expect(result.output).toContain("Failed (branches preserved): bd-m.3")
      },
    })
  })

  test("merge conflict between bead branches — conflict flagged", async () => {
    const beads = ["bd-m.1", "bd-m.2"]
    await using fx = await setupWithBranches(beads, { conflict: true })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const complete = await completeTool()
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.1", success: true }, ctx as any)
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.2", success: true }, ctx as any)

        const merge = await mergeTool()
        const result = await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        expect(result.output).toContain("Merged: 1/2 beads")
        expect(result.output).toContain("Conflicts (branches preserved): bd-m.2")
      },
    })
  })

  test("convoy closes and lead session receives completion signal", async () => {
    const beads = ["bd-m.1"]
    await using fx = await setupWithBranches(beads)
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const complete = await completeTool()
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.1", success: true }, ctx as any)

        const merge = await mergeTool()
        await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const out = await lines(fx.log)
        const closeCall = out.find((l) => l.startsWith("convoy close"))
        expect(closeCall).toBe("convoy close hq-team.1")

        const signalCall = out.find((l) => l.startsWith("signal convoy-complete"))
        expect(signalCall).toContain("--convoy hq-team.1")
        expect(signalCall).toContain("--merged 1")
        expect(signalCall).toContain("--total 1")
      },
    })
  })

  test("branch cleanup after successful merge", async () => {
    const beads = ["bd-m.1"]
    await using fx = await setupWithBranches(beads)
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const complete = await completeTool()
        await complete.execute({ convoy_id: "hq-team.1", bead_id: "bd-m.1", success: true }, ctx as any)

        const merge = await mergeTool()
        await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        // Verify branch was deleted
        const branches = await gitExec("git branch", fx.dir)
        expect(branches).not.toContain("bead_bd-m.1")
      },
    })
  })

  test("cannot merge while beads still running", async () => {
    await using fx = await setup({ beads: ["bd-m.1"] })
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const dispatch = await dispatchTool()
        await dispatch.execute({ convoy_id: "hq-team.1" }, ctx as any)

        const merge = await mergeTool()
        const result = await merge.execute({ convoy_id: "hq-team.1" }, ctx as any)

        expect(result.output).toContain("Cannot merge: 1 bead(s) still running")
      },
    })
  })
})
