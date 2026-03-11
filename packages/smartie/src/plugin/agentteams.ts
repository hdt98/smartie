import fs from "fs/promises"
import crypto from "crypto"
import os from "os"
import path from "path"
import { tool, type Plugin } from "@smartie-code/plugin"
import { Process } from "@/util/process"

type RunResult = {
  code: number
  stdout: string
  stderr: string
}

type TeamState = {
  id: string
  rig: string
  mode: "git" | "snapshot"
  target: string
  root: string
  snapshot?: string
  archive?: string
  meta: string
  convoy?: string
  session: string
}

function enabled() {
  const value = process.env["SMARTIE_AGENT_TEAMS"]?.toLowerCase()
  return value === "1" || value === "true"
}

function home() {
  return process.env.HOME || os.homedir()
}

function binpath() {
  return [path.join(home(), "go", "bin"), path.join(home(), ".local", "bin"), process.env.PATH ?? ""].join(":")
}

async function run(cmd: string[], cwd: string, env?: Record<string, string>): Promise<RunResult> {
  const out = await Process.run(cmd, {
    cwd,
    env: {
      ...process.env,
      PATH: binpath(),
      ...(env ?? {}),
    },
    nothrow: true,
  })
  return {
    code: out.code,
    stdout: out.stdout.toString().trim(),
    stderr: out.stderr.toString().trim(),
  }
}

function first(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
}

function convoy(text: string) {
  return text.match(/\b[a-z]+-[a-z0-9.-]+\b/i)?.[0] ?? first(text)
}

function reason(out: RunResult) {
  return out.stderr || out.stdout || "command failed without output"
}

function fallback(phase: string, reason: string) {
  return [
    `Agent Teams fallback: ${phase} failed.`,
    `Reason: ${reason}`,
    "Continue in the current session without creating a team.",
  ].join("\n")
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function hash(text: string) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8)
}

export function requestid(input: { session: string; call?: string; target: string }) {
  const sid = slug(input.session).slice(0, 16) || "session"
  const cid = slug(input.call ?? "call").slice(0, 16) || "call"
  return `rq-${sid}-${cid}-${hash(input.target)}`
}

export function requestrig(input: { session: string; call?: string; target: string }) {
  return `smartie-${requestid(input)}`.slice(0, 63)
}

export function requestmeta(id: string) {
  return path.join(home(), ".smartie", "agentteams", "requests", `${id}.json`)
}

export function requesttmp(id: string) {
  return path.join(os.tmpdir(), "smartie-agent-teams", id, "snapshot")
}

function requestarchive(id: string) {
  return path.join(os.tmpdir(), "smartie-agent-teams", id, "archive")
}

function beadDescription(item: { acceptance: string; targets: string[] }) {
  return `Acceptance: ${item.acceptance} | Targets: ${item.targets.join(", ")}`
}

function beadId(text: string) {
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed[0]?.id
    if (parsed && typeof parsed === "object" && "id" in parsed) return String(parsed.id)
  } catch {
    // Fall back to plain text extraction for older/noisy command output.
  }
  return convoy(text)
}

async function top(dir: string) {
  const out = await run(["git", "rev-parse", "--show-toplevel"], dir)
  if (out.code !== 0) return
  const root = out.stdout.trim()
  if (!root) return
  return root
}

async function write(state: TeamState, status: string, error?: string) {
  const next = {
    id: state.id,
    rig: state.rig,
    mode: state.mode,
    target: state.target,
    source: state.root,
    snapshot: state.snapshot,
    archive: state.archive,
    convoy: state.convoy,
    session: state.session,
    status,
    error,
    updated_at: new Date().toISOString(),
  }
  await fs.mkdir(path.dirname(state.meta), { recursive: true })
  await Bun.write(state.meta, JSON.stringify(next, null, 2) + "\n")
}

async function snapshot(target: string, id: string) {
  const dir = requesttmp(id)
  const clash = await fs
    .access(dir)
    .then(() => true)
    .catch(() => false)
  if (clash) return { error: `temporary snapshot collision at ${dir}` }

  await fs.mkdir(path.dirname(dir), { recursive: true })
  const copied = await fs
    .cp(target, dir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    })
    .then(() => true)
    .catch(() => false)
  if (!copied) return { error: `failed to copy target into temporary snapshot at ${dir}` }

  const init = await run(["git", "init"], dir)
  if (init.code !== 0) {
    await fs.rm(dir, { recursive: true, force: true })
    return { error: reason(init) }
  }
  const add = await run(["git", "add", "-A"], dir)
  if (add.code !== 0) {
    await fs.rm(dir, { recursive: true, force: true })
    return { error: reason(add) }
  }
  const commit = await run(
    ["git", "commit", "--allow-empty", "-m", `smartie request snapshot ${id}`],
    dir,
    {
      GIT_AUTHOR_NAME: "smartie",
      GIT_AUTHOR_EMAIL: "smartie@example.local",
      GIT_COMMITTER_NAME: "smartie",
      GIT_COMMITTER_EMAIL: "smartie@example.local",
    },
  )
  if (commit.code !== 0) {
    await fs.rm(dir, { recursive: true, force: true })
    return { error: reason(commit) }
  }
  return { dir }
}

async function cleanup(state: TeamState, cwd: string, note: string) {
  const rid = await run(["gt", "rig", "remove", state.rig], cwd)
  let err = rid.code === 0 ? "" : `rig remove failed: ${reason(rid)}`

  if (state.snapshot) {
    const arc = requestarchive(state.id)
    await fs.mkdir(path.dirname(arc), { recursive: true })
    const moved = await fs
      .rename(state.snapshot, arc)
      .then(() => "")
      .catch((e) => String(e))
    if (!moved) state.archive = arc
    if (moved) err = err ? `${err}; snapshot archive failed: ${moved}` : `snapshot archive failed: ${moved}`
  }

  await write(state, err ? "cleanup_failed" : "cleaned", err || note)
}

async function provision(input: { cwd: string; session: string; call?: string }) {
  const id = requestid({
    session: input.session,
    call: input.call,
    target: input.cwd,
  })
  const rig = requestrig({
    session: input.session,
    call: input.call,
    target: input.cwd,
  })
  const meta = requestmeta(id)
  const root = await top(input.cwd)

  if (root) {
    const add = await run(["gt", "rig", "add", rig, root, "--local-repo", root], input.cwd)
    if (add.code !== 0) return { error: `request rig creation failed: ${reason(add)}` }
    const state: TeamState = {
      id,
      rig,
      mode: "git",
      target: input.cwd,
      root,
      meta,
      session: input.session,
    }
    await write(state, "provisioned")
    return { state }
  }

  const boot = await snapshot(input.cwd, id)
  if (boot.error) return { error: `snapshot bootstrap failed: ${boot.error}` }

  const add = await run(["gt", "rig", "add", rig, boot.dir, "--local-repo", boot.dir], input.cwd)
  if (add.code !== 0) {
    await fs.rm(boot.dir, { recursive: true, force: true })
    return { error: `request rig creation failed: ${reason(add)}` }
  }

  const state: TeamState = {
    id,
    rig,
    mode: "snapshot",
    target: input.cwd,
    root: boot.dir,
    snapshot: boot.dir,
    meta,
    session: input.session,
  }
  await write(state, "provisioned")
  return { state }
}

export const AgentTeamsPlugin: Plugin = async (input) => {
  if (!enabled()) return {}
  const sessions = new Map<string, TeamState>()
  const convoys = new Map<string, TeamState>()

  return {
    tool: {
      agent_team_create: tool({
        description:
          "Create an Agent Team convoy with beads for an explicitly requested team or a complex task you decide should be decomposed into parallel sub-tasks. If creation or dispatch fails, this tool falls back to single-session execution instead of aborting.",
        args: {
          goal: tool.schema.string().describe("The overall task or outcome for the team."),
          reason: tool.schema
            .string()
            .describe("Why parallel execution is useful, for example independent files or clear sub-problems."),
          tasks: tool.schema
            .array(
              tool.schema.object({
                description: tool.schema.string().describe("A short bead title."),
                acceptance: tool.schema.string().describe("Concrete acceptance criteria for this bead."),
                targets: tool.schema
                  .array(tool.schema.string())
                  .describe("Files, modules, or areas this bead should target."),
              }),
            )
            .min(1)
            .describe("Independent sub-tasks for the convoy."),
        },
        async execute(args, ctx) {
          const ready = await provision({
            cwd: input.directory,
            session: ctx.sessionID,
            call: ctx.callID,
          })
          if (ready.error) return fallback("request rig provisioning", ready.error)
          const state = ready.state
          sessions.set(ctx.sessionID, state)

          const created: string[] = []
          for (const item of args.tasks) {
            const bead = await run(
              [
                "bd",
                "create",
                "--title",
                item.description,
                "--description",
                beadDescription(item),
                "--type",
                "task",
                "--priority",
                "2",
                "--json",
              ],
              state.root,
            )
            if (bead.code !== 0) {
              await cleanup(state, state.root, "fallback after bead creation failure")
              return fallback("bead creation", reason(bead))
            }
            const id = beadId(bead.stdout)
            if (!id) {
              await cleanup(state, state.root, "fallback after bead creation failure")
              return fallback("bead creation", "bead id missing from bd create output")
            }
            created.push(id)
          }

          if (!created.length) {
            await cleanup(state, state.root, "fallback after bead creation failure")
            return fallback("bead creation", "no bead ids were created")
          }

          const makeConvoy = await run(["gt", "convoy", "create", args.goal, created[0]!], state.root)
          if (makeConvoy.code !== 0) {
            await cleanup(state, state.root, "fallback after convoy creation failure")
            return fallback("convoy creation", reason(makeConvoy))
          }

          const convoyID = convoy(makeConvoy.stdout)
          if (!convoyID) {
            await cleanup(state, state.root, "fallback after convoy creation failure")
            return fallback("convoy creation", "convoy id missing from gt convoy create output")
          }
          state.convoy = convoyID
          convoys.set(convoyID, state)
          await write(state, "active")

          if (created.length > 1) {
            const add = await run(["gt", "convoy", "add", convoyID, ...created.slice(1)], state.root)
            if (add.code !== 0) {
              await cleanup(state, state.root, "fallback after convoy add failure")
              return fallback("convoy add", reason(add))
            }
          }

          const dispatch = await run(
            ["gt", "mayor", "dispatch", "--convoy", convoyID, "--rig", state.rig, "--request", state.id, "--root", state.root],
            state.root,
          )
          if (dispatch.code !== 0) {
            await cleanup(state, state.root, "fallback after mayor dispatch failure")
            return fallback("mayor dispatch", reason(dispatch))
          }

          return [
            `Created Agent Team convoy ${convoyID}.`,
            `Request: ${state.id}`,
            `Rig: ${state.rig} (${state.mode})`,
            `Source: ${state.root}`,
            `Cleanup metadata: ${state.meta}`,
            `Reason: ${args.reason}`,
            created.length ? `Beads: ${created.join(", ")}` : "Beads: created",
            `Dispatched convoy ${convoyID} to Mayor for rig ${state.rig}.`,
          ].join("\n")
        },
      }),
    },
    async "tool.execute.after"(evt, _output) {
      if (evt.tool !== "mayor_convoy_merge") return
      const id = typeof evt.args?.convoy_id === "string" ? evt.args.convoy_id : ""
      if (!id) return
      const state = convoys.get(id)
      if (!state) return
      await cleanup(state, input.directory, "convoy complete")
      convoys.delete(id)
      if (sessions.get(state.session)?.id === state.id) sessions.delete(state.session)
    },
    async "experimental.chat.system.transform"(_input, output) {
      output.system.push(
        [
          "Agent Teams are enabled for this session.",
          "If the user explicitly asks to create an agent team, convoy, or beads, you may use the agent_team_create tool.",
          "You may also propose and use agent_team_create on your own when the task decomposes into independent parallel sub-tasks with clear file or module boundaries.",
          "Only create teams when the work can be split cleanly. If the tool reports fallback, continue in the current session without retrying orchestration.",
        ].join("\n"),
      )
    },
  }
}
