import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { ToolRegistry } from "../../src/tool/registry"
import { Auth } from "../../src/auth"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { Global } from "../../src/global"
import { Question } from "../../src/question"
import { requestid, requestmeta, requestrig, requesttmp } from "../../src/plugin/agentteams"

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

function mctx(provider = "lead-test", model = "lead-model") {
  return {
    ...ctx,
    extra: {
      model: {
        providerID: provider,
        modelID: model,
      },
    },
  }
}

async function seed(provider = "lead-test") {
  await Auth.set(provider, { type: "api", key: "k" })
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
  const bd = path.join(bin, "bd")
  const git = path.join(bin, "git")
  const log = path.join(tmp.path, "gt.log")
  const count = path.join(tmp.path, "gt.count")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(bin, { recursive: true })
  await Bun.write(
    gt,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s %s\\n' \"$(basename \"$0\")\" \"$*\" >> \"$GT_LOG\"",
      "self=$(basename \"$0\")",
      "if [[ \"$self\" == \"git\" && \"${1:-}\" == \"rev-parse\" && \"${2:-}\" == \"--show-toplevel\" ]]; then",
      "  if [[ \"${GT_GIT_MODE:-git}\" == \"nogit\" ]]; then",
      "    echo 'not a git repository' >&2",
      "    exit 1",
      "  fi",
      "  echo \"${GT_GIT_ROOT}\"",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"git\" && \"${1:-}\" == \"remote\" && \"${2:-}\" == \"get-url\" && \"${3:-}\" == \"origin\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"origin-url\" ]]; then",
      "    echo 'origin missing' >&2",
      "    exit 1",
      "  fi",
      "  echo \"${GT_REMOTE_URL:-git@github.com:hdt98/smartie.git}\"",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"git\" && \"${1:-}\" == \"init\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"snapshot-init\" ]]; then",
      "    echo 'snapshot init failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'Initialized empty Git repository'",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"git\" && \"${1:-}\" == \"add\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"snapshot-add\" ]]; then",
      "    echo 'snapshot add failed' >&2",
      "    exit 1",
      "  fi",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"git\" && \"${1:-}\" == \"commit\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"snapshot-commit\" ]]; then",
      "    echo 'snapshot commit failed' >&2",
      "    exit 1",
      "  fi",
      "  echo '[main 1] snapshot'",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"gt\" && \"${1:-}\" == \"rig\" && \"${2:-}\" == \"add\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"rig-add\" ]]; then",
      "    echo 'rig add failed' >&2",
      "    exit 1",
      "  fi",
      "  if [[ \"${4:-}\" != \"--adopt\" && \"${4:-}\" == /* ]]; then",
      "    echo \"Error: invalid git URL \\\"${4}\\\": expected a remote URL\" >&2",
      "    exit 1",
      "  fi",
      "  echo 'rig add ok'",
      "  exit 0",
      "fi",
      "if [[ \"$self\" == \"gt\" && \"${1:-}\" == \"rig\" && \"${2:-}\" == \"remove\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"rig-remove\" ]]; then",
      "    echo 'rig remove failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'rig remove ok'",
      "  exit 0",
      "fi",
      "if [[ (\"$self\" == \"bd\" && \"${1:-}\" == \"create\") || (\"${1:-}\" == \"bd\" && \"${2:-}\" == \"create\") ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"bead\" ]]; then",
      "    echo 'bead failed' >&2",
      "    exit 1",
      "  fi",
      "  n=$(cat \"$GT_COUNT\" 2>/dev/null || echo 0)",
      "  n=$((n+1))",
      "  printf '%s' \"$n\" > \"$GT_COUNT\"",
      "  echo \"{\\\"id\\\":\\\"bd-team.$n\\\"}\"",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"convoy\" && \"${2:-}\" == \"create\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"convoy\" ]]; then",
      "    echo 'convoy failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'hq-team.1'",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"convoy\" && \"${2:-}\" == \"add\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"convoy-add\" ]]; then",
      "    echo 'convoy add failed' >&2",
      "    exit 1",
      "  fi",
      "  echo 'convoy add ok'",
      "  exit 0",
      "fi",
      "if [[ \"${1:-}\" == \"mayor\" && \"${2:-}\" == \"dispatch\" ]]; then",
      "  if [[ \"${GT_FAIL:-}\" == \"mayor\" ]]; then",
      "    echo 'mayor unavailable' >&2",
      "    exit 1",
      "  fi",
      "  echo 'mayor dispatch ok'",
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
  await fs.copyFile(gt, bd)
  await fs.chmod(bd, 0o755)
  await fs.copyFile(gt, git)
  await fs.chmod(git, 0o755)
  process.env.HOME = home
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`
  process.env.GT_LOG = log
  process.env.GT_COUNT = count
  if (!process.env.GT_GIT_MODE) process.env.GT_GIT_MODE = "git"
  if (!process.env.GT_GIT_ROOT) process.env.GT_GIT_ROOT = tmp.path
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

  test("missing provider auth blocks team creation before request rig provisioning", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["SMARTIE_AGENT_TEAMS_AUTH_WAIT_MS"] = "10"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const events: any[] = []
        const unsub = Bus.subscribeAll((event) => {
          events.push(event)
        })
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx("auth-missing", "lead-model") as any,
        )
        unsub()

        const out = await lines(fx.log)
        expect(out.some((line) => line.startsWith("gt rig add"))).toBe(false)
        expect(result.output).toContain("Agent Teams fallback: provider authentication failed.")
        expect(result.output).toContain("provider 'auth-missing' is not authenticated")
        expect(
          events.some((event) => event.type === TuiEvent.ToastShow.type && event.properties.message.includes("Connect provider 'auth-missing'")),
        ).toBe(true)
        expect(
          events.some((event) => event.type === TuiEvent.CommandExecute.type && event.properties.command === "provider.connect"),
        ).toBe(true)
      },
    })
  })

  test("provider connect flow resumes the same request after auth succeeds", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["SMARTIE_AGENT_TEAMS_AUTH_WAIT_MS"] = "1200"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        const tool = await teamTool()
        const unsub = Bus.subscribe(TuiEvent.CommandExecute, async (event) => {
          if (event.properties.command !== "provider.connect") return
          await Auth.set("auth-resume", { type: "api", key: "k" })
        })

        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx("auth-resume", "lead-model") as any,
        )
        unsub()
        const out = await lines(fx.log)
        expect(out.some((line) => line.startsWith("gt rig add"))).toBe(true)
        expect(result.output).toContain("Created Agent Team convoy hq-team.1.")
        expect(result.output).toContain("Provider: auth-resume/lead-model")
      },
    })
  })

  test("missing shared auth store fails early before rig provisioning", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    process.env["SMARTIE_AUTH_PATH"] = path.join(fx.dir, "missing", "auth.json")
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed("auth-path-missing")
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx("auth-path-missing", "lead-model") as any,
        )
        const out = await lines(fx.log)
        expect(out.some((line) => line.startsWith("gt rig add"))).toBe(false)
        expect(result.output).toContain("Agent Teams fallback: provider authentication failed.")
        expect(result.output).toContain(`shared auth store not found at ${process.env["SMARTIE_AUTH_PATH"]}`)
      },
    })
  })

  test("git-backed requests provision a request rig and dispatch to it", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
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
          mctx() as any,
        )

        const out = await lines(fx.log)
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const id = requestid({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const meta = requestmeta(id)

        expect(out.some((line) => line.startsWith(`git rev-parse --show-toplevel`))).toBe(true)
        expect(out.some((line) => line === "git remote get-url origin")).toBe(true)
        expect(out.some((line) => line === `gt rig add ${rid} git@github.com:hdt98/smartie.git --local-repo ${fx.dir}`)).toBe(true)
        expect(out.some((line) => line.includes("bd create --title Refactor lexer"))).toBe(true)
        expect(out.some((line) => line.includes("bd create --title Refactor parser"))).toBe(true)
        expect(out.some((line) => line === "gt convoy create Refactor the parser stack bd-team.1")).toBe(true)
        expect(out.some((line) => line === "gt convoy add hq-team.1 bd-team.2")).toBe(true)
        expect(
          out.some(
            (line) =>
              line ===
              `gt mayor dispatch --convoy hq-team.1 --rig ${rid} --request ${id} --root ${fx.dir} --provider lead-test --model lead-model --runtime build --auth-path ${path.join(Global.Path.data, "auth.json")}`,
          ),
        ).toBe(true)
        expect(result.output).toContain("Created Agent Team convoy hq-team.1.")
        expect(result.output).toContain(`Request: ${id}`)
        expect(result.output).toContain(`Rig: ${rid} (git)`)
        expect(result.output).toContain("Provider: lead-test/lead-model")
        expect(result.output).toContain(`Cleanup metadata: ${meta}`)
        expect(result.output).toContain("Beads: bd-team.1, bd-team.2")
        expect(result.output).toContain(`Dispatched convoy hq-team.1 to Mayor for rig ${rid}.`)
      },
    })
  })

  test("explicit target overrides current workspace for request rig provisioning", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    const target = path.join(fx.dir, "other")
    await fs.mkdir(target, { recursive: true })
    process.env["GT_GIT_ROOT"] = target
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const out = await tool.execute(
          {
            goal: "Inspect target workspace",
            reason: "Need different repo",
            target,
            tasks: [{ description: "Check", acceptance: "Done", targets: ["README.md"] }],
          },
          mctx() as any,
        )
        const linesOut = await lines(fx.log)
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target })
        expect(linesOut.some((line) => line === `gt rig add ${rid} git@github.com:hdt98/smartie.git --local-repo ${target}`)).toBe(true)
        expect(out.output).toContain(`Target: ${target}`)
      },
    })
  })

  test("ambiguous target asks for confirmation and uses selected workspace", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    const target = path.join(fx.dir, "alt")
    await fs.mkdir(target, { recursive: true })
    process.env["GT_GIT_ROOT"] = target
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const asked: any[] = []
        const unsub = Bus.subscribe(Question.Event.Asked, async (event) => {
          asked.push(event)
          await Question.reply({
            requestID: event.properties.id,
            answers: [[target]],
          })
        })
        const tool = await teamTool()
        const out = await tool.execute(
          {
            goal: "Inspect another repo",
            reason: "Could be outside this workspace",
            tasks: [{ description: "Check", acceptance: "Done", targets: ["../alt"] }],
          },
          mctx() as any,
        )
        unsub()

        const linesOut = await lines(fx.log)
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target })
        expect(asked.length).toBe(1)
        expect(linesOut.some((line) => line === `gt rig add ${rid} git@github.com:hdt98/smartie.git --local-repo ${target}`)).toBe(true)
        expect(out.output).toContain(`Target: ${target}`)
      },
    })
  })

  test("convoy creation command is compatible with gt binaries without --session", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        await tool.execute(
          {
            goal: "Split work safely",
            reason: "parallel tasks",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )

        const out = await lines(fx.log)
        const cmd = out.find((line) => line.startsWith("gt convoy create "))
        expect(cmd).toBeDefined()
        expect(cmd).toContain("Split work safely bd-team.1")
        expect(cmd).not.toContain("--session")
      },
    })
  })

  test("non-git targets bootstrap snapshot and provision request rig", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_GIT_MODE"] = "nogit"
    await using fx = await setup()
    await Bun.write(path.join(fx.dir, "note.txt"), "hello")
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        const out = await lines(fx.log)
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const id = requestid({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const snap = requesttmp(id)

        expect(out.some((line) => line === "git rev-parse --show-toplevel")).toBe(true)
        expect(out.some((line) => line === "git init")).toBe(true)
        expect(out.some((line) => line === "git add -A")).toBe(true)
        expect(out.some((line) => line.startsWith("git commit --allow-empty -m smartie request snapshot"))).toBe(true)
        expect(out.some((line) => line === `gt rig add ${rid} --adopt --force`)).toBe(true)
        expect(result.output).toContain(`Rig: ${rid} (snapshot)`)
        expect(result.output).toContain(`Source: ${snap}`)
      },
    })
  })

  test("git-backed requests adopt the local workspace instead of passing it as a git URL", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Inspect this workspace",
            reason: "Need a request rig",
            tasks: [{ description: "Check workspace", acceptance: "No file changes", targets: ["README.md"] }],
          },
          mctx() as any,
        )

        const out = await lines(fx.log)
        expect(out.some((line) => line === "git remote get-url origin")).toBe(true)
        expect(out.some((line) => line === `gt rig add ${requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })} git@github.com:hdt98/smartie.git --local-repo ${fx.dir}`)).toBe(true)
        expect(out.some((line) => line.includes(` ${fx.dir} --local-repo ${fx.dir}`))).toBe(false)
        expect(result.output).toContain("Created Agent Team convoy hq-team.1.")
      },
    })
  })

  test("missing origin remote blocks git-backed request rig provisioning cleanly", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "origin-url"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Inspect this workspace",
            reason: "Need a request rig",
            tasks: [{ description: "Check workspace", acceptance: "No file changes", targets: ["README.md"] }],
          },
          mctx() as any,
        )
        expect(result.output).toContain("Agent Teams fallback: request rig provisioning failed.")
        expect(result.output).toContain(`could not determine origin remote for ${fx.dir}`)
      },
    })
  })

  test("rig provisioning failure falls back cleanly", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "rig-add"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        expect(result.output).toContain("Agent Teams fallback: request rig provisioning failed.")
        expect(result.output).toContain("Continue in the current session")
      },
    })
  })

  test("convoy creation failure falls back and cleans rig", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "convoy"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        const out = await lines(fx.log)
        expect(out.some((line) => line === `gt rig remove ${rid}`)).toBe(true)
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
        await seed()
        const tool = await teamTool()
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        const out = await lines(fx.log)
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        expect(out.some((line) => line.includes("bd create --title One --description Acceptance: Done | Targets: a.ts --type task --priority 2 --json"))).toBe(
          true,
        )
        expect(out.some((line) => line === `gt rig remove ${rid}`)).toBe(true)
        expect(result.output).toContain("Agent Teams fallback: bead creation failed.")
      },
    })
  })

  test("convoy add failure falls back to single-session execution", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    process.env["GT_FAIL"] = "convoy-add"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [
              { description: "One", acceptance: "Done", targets: ["a.ts"] },
              { description: "Two", acceptance: "Done", targets: ["b.ts"] },
            ],
          },
          mctx() as any,
        )
        const out = await lines(fx.log)
        expect(out.some((line) => line === "gt convoy create Split the migration work bd-team.1")).toBe(true)
        expect(out.some((line) => line === "gt convoy add hq-team.1 bd-team.2")).toBe(true)
        expect(out.some((line) => line === `gt rig remove ${rid}`)).toBe(true)
        expect(result.output).toContain("Agent Teams fallback: convoy add failed.")
        expect(result.output).toContain("Continue in the current session")
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
        await seed()
        const tool = await teamTool()
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const id = requestid({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        const result = await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        const out = await lines(fx.log)
        expect(
          out.some(
            (line) =>
              line ===
              `gt mayor dispatch --convoy hq-team.1 --rig ${rid} --request ${id} --root ${fx.dir} --provider lead-test --model lead-model --runtime build --auth-path ${path.join(Global.Path.data, "auth.json")}`,
          ),
        ).toBe(true)
        expect(out.some((line) => line === `gt rig remove ${rid}`)).toBe(true)
        expect(result.output).toContain("Agent Teams fallback: mayor dispatch failed.")
        expect(result.output).toContain("Continue in the current session")
      },
    })
  })

  test("request id and metadata paths are deterministic", async () => {
    const input = { session: "ses-team", call: "call-team", target: "/tmp/work" }
    const id1 = requestid(input)
    const id2 = requestid(input)
    const rig1 = requestrig(input)
    const rig2 = requestrig(input)
    const meta1 = requestmeta(id1)
    const meta2 = requestmeta(id2)
    const tmp1 = requesttmp(id1)
    const tmp2 = requesttmp(id2)
    expect(id1).toBe(id2)
    expect(rig1).toBe(rig2)
    expect(rig1).toMatch(/^smartie_[a-z0-9_]+$/)
    expect(meta1).toBe(meta2)
    expect(tmp1).toBe(tmp2)
  })

  test("convoy completion hook cleans request rig resources", async () => {
    process.env["SMARTIE_AGENT_TEAMS"] = "1"
    await using fx = await setup()
    await Instance.provide({
      directory: fx.dir,
      fn: async () => {
        await seed()
        const tool = await teamTool()
        const rid = requestrig({ session: ctx.sessionID, call: ctx.callID, target: fx.dir })
        await tool.execute(
          {
            goal: "Split the migration work",
            reason: "Work is parallelizable",
            tasks: [{ description: "One", acceptance: "Done", targets: ["a.ts"] }],
          },
          mctx() as any,
        )
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "mayor_convoy_merge",
            sessionID: ctx.sessionID,
            callID: "call-merge",
            args: { convoy_id: "hq-team.1" },
          } as any,
          {} as any,
        )

        const out = await lines(fx.log)
        expect(out.some((line) => line === `gt rig remove ${rid}`)).toBe(true)
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
