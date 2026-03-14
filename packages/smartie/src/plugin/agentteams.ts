import fs from "fs/promises"
import crypto from "crypto"
import os from "os"
import path from "path"
import { tool, type Plugin } from "@smartie-code/plugin"
import { Process } from "@/util/process"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Global } from "@/global"
import { Question } from "@/question"

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
  provider?: string
  model?: string
  runtime?: string
  authPath?: string
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

function toint(input: string | undefined, fallback: number) {
  const value = Number(input)
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function slug(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function hash(text: string) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8)
}

function remote(text: string) {
  const input = text.trim()
  if (!input) return false
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/)/i.test(input)) return true
  return /^[a-z0-9._-]+@[a-z0-9._-]+:.+/i.test(input)
}

export function requestid(input: { session: string; call?: string; target: string }) {
  const sid = slug(input.session).slice(0, 16) || "session"
  const cid = slug(input.call ?? "call").slice(0, 16) || "call"
  return `rq-${sid}-${cid}-${hash(input.target)}`
}

export function requestrig(input: { session: string; call?: string; target: string }) {
  return `smartie_${requestid(input).replace(/-/g, "_")}`.slice(0, 63)
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

async function waitAuth(input: { provider: string }) {
  const limit = toint(process.env["SMARTIE_AGENT_TEAMS_AUTH_WAIT_MS"], 120000)
  const step = 500
  const loops = Math.max(1, Math.ceil(limit / step))
  for (let i = 0; i < loops; i++) {
    const auth = await Auth.get(input.provider)
    if (auth) return auth
    await Bun.sleep(step)
  }
}

async function preflight(ctx: any) {
  const model = (ctx.extra as any)?.model
  const provider = typeof model?.providerID === "string" ? model.providerID : ""
  const modelID = typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : ""
  const runtime = typeof ctx.agent === "string" ? ctx.agent : "build"
  if (!provider || !modelID) return { error: "lead session provider/model is missing for auth preflight" }

  const known = await Provider.getProvider(provider)
  let auth = await Auth.get(provider)
  if (!auth && !known?.key) {
    await Bus.publish(TuiEvent.ToastShow, {
      title: "Provider auth required",
      message: `Connect provider '${provider}' to start Agent Teams`,
      variant: "warning",
    })
    await Bus.publish(TuiEvent.CommandExecute, {
      command: "provider.connect",
    })
    auth = await waitAuth({ provider })
    if (!auth) return { error: `provider '${provider}' is not authenticated. connect flow did not complete in time` }
  }

  const authPath = process.env["SMARTIE_AUTH_PATH"] || path.join(Global.Path.data, "auth.json")
  if (auth) {
    const has = await fs
      .access(authPath)
      .then(() => true)
      .catch(() => false)
    if (!has) return { error: `shared auth store not found at ${authPath}` }
  }
  return {
    provider,
    model: modelID,
    runtime,
    authPath: auth ? authPath : "",
  }
}

function abs(cwd: string, dir: string) {
  return path.isAbsolute(dir) ? path.normalize(dir) : path.resolve(cwd, dir)
}

function outside(cwd: string, dir: string) {
  const root = path.resolve(cwd)
  const target = abs(cwd, dir)
  if (target === root) return false
  return !target.startsWith(root + path.sep)
}

function unsure(goal: string, reason: string) {
  const text = `${goal}\n${reason}`.toLowerCase()
  return ["another repo", "different repo", "different folder", "other folder", "outside this repo", "outside this workspace"].some((item) =>
    text.includes(item),
  )
}

async function pick(input: {
  cwd: string
  goal: string
  reason: string
  tasks: { targets: string[] }[]
  target?: string
  ctx: any
}) {
  if (input.target?.trim()) {
    const target = input.target.trim()
    if (remote(target)) return { dir: target, asked: false as const }
    return { dir: abs(input.cwd, target), asked: false as const }
  }
  const need = input.tasks.some((task) => task.targets.some((target) => outside(input.cwd, target))) || unsure(input.goal, input.reason)
  if (!need) return { dir: input.cwd, asked: false as const }

  const answers = await Question.ask({
    sessionID: input.ctx.sessionID,
    tool: {
      messageID: input.ctx.messageID,
      callID: input.ctx.callID,
    },
    questions: [
      {
        header: "Team Target",
        question: `Use current workspace as Agent Team target?\nCurrent: ${input.cwd}`,
        options: [
          {
            label: "Use current workspace",
            description: "Run Agent Teams in the current workspace",
          },
        ],
        custom: true,
      },
    ],
  }).catch(() => [] as string[][])
  const selected = answers[0]?.[0]?.trim() ?? ""
  if (!selected || selected === "Use current workspace") return { dir: input.cwd, asked: true as const }
  return { dir: abs(input.cwd, selected), asked: true as const }
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

type ChangedFiles = {
  modified: string[]
  added: string[]
  deleted: string[]
}

async function getChangedFiles(snapshot: string, root: string): Promise<ChangedFiles> {
  const modified: string[] = []
  const added: string[] = []
  const deleted: string[] = []

  const snapshotFiles = await fs.readdir(snapshot, { recursive: true, withFileTypes: true }).catch(() => [])
  const snapshotPaths = new Set<string>()
  for (const entry of snapshotFiles) {
    if (entry.isFile()) {
      const rel = path.relative(snapshot, path.join(entry.parent?.path ?? snapshot, entry.name))
      snapshotPaths.add(rel)
    }
  }

  const rootFiles = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
  const rootPaths = new Set<string>()
  for (const entry of rootFiles) {
    if (entry.isFile()) {
      const rel = path.relative(root, path.join(entry.parent?.path ?? root, entry.name))
      if (!rel.startsWith(".git") && !rel.startsWith("mayor") && !rel.startsWith(".worktrees")) {
        rootPaths.add(rel)
      }
    }
  }

  for (const file of rootPaths) {
    if (!snapshotPaths.has(file)) {
      added.push(file)
    } else {
      const snapshotPath = path.join(snapshot, file)
      const rootPath = path.join(root, file)
      const snapshotExists = await fs.stat(snapshotPath).then(() => true).catch(() => false)
      const rootExists = await fs.stat(rootPath).then(() => true).catch(() => false)
      if (snapshotExists && rootExists) {
        const snapshotContent = await Bun.file(snapshotPath).text().catch(() => "")
        const rootContent = await Bun.file(rootPath).text().catch(() => "")
        if (snapshotContent !== rootContent) {
          modified.push(file)
        }
      }
    }
  }

  for (const file of snapshotPaths) {
    if (!rootPaths.has(file)) {
      deleted.push(file)
    }
  }

  return { modified, added, deleted }
}

async function applyBack(state: TeamState, changed: ChangedFiles): Promise<string> {
  if (!state.snapshot || !state.target) return ""

  const errors: string[] = []

  for (const file of changed.modified) {
    const src = path.join(state.root, file)
    const dst = path.join(state.target, file)
    const dir = path.dirname(dst)
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await fs.copyFile(src, dst).catch((e) => errors.push(`failed to copy modified ${file}: ${e}`))
  }

  for (const file of changed.added) {
    const src = path.join(state.root, file)
    const dst = path.join(state.target, file)
    const dir = path.dirname(dst)
    await fs.mkdir(dir, { recursive: true }).catch(() => {})
    await fs.copyFile(src, dst).catch((e) => errors.push(`failed to copy new ${file}: ${e}`))
  }

  return errors.join("; ")
}

async function askDeletionApproval(sessionID: string, deletions: string[]): Promise<boolean> {
  const answers = await Question.ask({
    sessionID,
    questions: [
      {
        header: "Apply Deletions",
        question: `The following files will be deleted from the original target:\n${deletions.join("\n")}\n\nApply these deletions?`,
        options: [
          { label: "Apply deletions", description: "Delete the listed files from the original target" },
          { label: "Skip deletions", description: "Keep the files, do not delete them" },
        ],
        custom: false,
      },
    ],
  }).catch(() => [])
  const answer = answers[0]?.[0]?.trim() ?? ""
  return answer === "Apply deletions"
}

async function applyDeletions(state: TeamState, deletions: string[]): Promise<string> {
  if (!state.target) return ""
  const errors: string[] = []
  for (const file of deletions) {
    const dst = path.join(state.target, file)
    await fs.rm(dst).catch((e) => errors.push(`failed to delete ${file}: ${e}`))
  }
  return errors.join("; ")
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

async function remoteurl(dir: string) {
  const out = await run(["git", "remote", "get-url", "origin"], dir)
  if (out.code !== 0) return
  const url = out.stdout.trim()
  if (!url) return
  return url
}

async function rigroot(name: string, cwd: string) {
  const out = await run(["gt", "rig", "status", name], cwd)
  if (out.code !== 0) return { error: reason(out) }
  const line = out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("Path:"))
  if (!line) return { error: `request rig status missing Path for ${name}` }
  const rig = line.replace(/^Path:\s*/, "").trim()
  if (!rig) return { error: `request rig status returned empty Path for ${name}` }
  const mayor = path.join(rig, "mayor", "rig")
  const has = await fs
    .stat(mayor)
    .then((item) => item.isDirectory())
    .catch(() => false)
  return { root: has ? mayor : rig }
}

async function addrequestRig(name: string, dir: string, opts?: { force?: boolean }) {
  const args = ["gt", "rig", "add", name, "--adopt"]
  if (opts?.force) args.push("--force")
  return run(args, dir)
}

async function provision(input: { cwd: string; session: string; call?: string; host: string }) {
  if (remote(input.cwd)) {
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
    const add = await run(["gt", "rig", "add", rig, input.cwd], input.host)
    if (add.code !== 0) return { error: `request rig creation failed: ${reason(add)}` }
    const root = await rigroot(rig, input.host)
    if ("error" in root) {
      await run(["gt", "rig", "remove", rig], input.host)
      return { error: `request rig creation failed: ${root.error}` }
    }
    const state: TeamState = {
      id,
      rig,
      mode: "git",
      target: input.cwd,
      root: root.root,
      meta,
      session: input.session,
    }
    await write(state, "provisioned")
    return { state }
  }

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
    const url = await remoteurl(root)
    if (!url) return { error: `request rig creation failed: could not determine origin remote for ${root}` }
    const add = await run(["gt", "rig", "add", rig, url, "--local-repo", root], input.cwd)
    if (add.code !== 0) return { error: `request rig creation failed: ${reason(add)}` }
    const rr = await rigroot(rig, input.cwd)
    if ("error" in rr) {
      await run(["gt", "rig", "remove", rig], input.cwd)
      return { error: `request rig creation failed: ${rr.error}` }
    }
    const state: TeamState = {
      id,
      rig,
      mode: "git",
      target: input.cwd,
      root: rr.root,
      meta,
      session: input.session,
    }
    await write(state, "provisioned")
    return { state }
  }

  const boot = await snapshot(input.cwd, id)
  if (boot.error) return { error: `snapshot bootstrap failed: ${boot.error}` }

  const add = await addrequestRig(rig, boot.dir, { force: true })
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
          target: tool.schema
            .string()
            .optional()
            .describe("Optional explicit target repo/folder path for Agent Teams."),
        },
        async execute(args, ctx) {
          const auth = await preflight(ctx)
          if ("error" in auth) return fallback("provider authentication", auth.error)

          const target = await pick({
            cwd: input.directory,
            goal: args.goal,
            reason: args.reason,
            tasks: args.tasks,
            target: args.target,
            ctx,
          })
          if (!remote(target.dir)) {
            const exists = await fs
              .stat(target.dir)
              .then((item) => item.isDirectory())
              .catch(() => false)
            if (!exists) return fallback("target resolution", `selected target does not exist: ${target.dir}`)
          }
          await Bus.publish(TuiEvent.ToastShow, {
            title: "Agent Team target",
            message: `Using target workspace: ${target.dir}`,
            variant: "info",
          })

          const ready = await provision({
            cwd: target.dir,
            session: ctx.sessionID,
            call: ctx.callID,
            host: input.directory,
          })
          if (ready.error) return fallback("request rig provisioning", ready.error)
          const state = ready.state
          state.provider = auth.provider
          state.model = auth.model
          state.runtime = auth.runtime
          state.authPath = auth.authPath
          if (auth.authPath) {
            const hasAuthPath = await fs
              .access(auth.authPath)
              .then(() => true)
              .catch(() => false)
            if (!hasAuthPath) {
              await cleanup(state, state.root, "fallback after auth inheritance failure")
              return fallback("auth inheritance", `shared auth store not found at ${auth.authPath}`)
            }
          }
          if (!auth.authPath && !(await Provider.getProvider(auth.provider))) {
            await cleanup(state, state.root, "fallback after auth inheritance failure")
            return fallback("auth inheritance", `provider auth inheritance could not be established for ${auth.provider}`)
          }
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
            [
              "gt",
              "mayor",
              "dispatch",
              "--convoy",
              convoyID,
              "--rig",
              state.rig,
              "--request",
              state.id,
              "--root",
              state.root,
              "--provider",
              state.provider,
              "--model",
              state.model,
              "--runtime",
              state.runtime,
              "--auth-path",
              state.authPath,
            ],
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
            `Target: ${state.target}`,
            `Source: ${state.root}`,
            `Provider: ${state.provider}/${state.model}`,
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

      if (state.mode === "snapshot" && state.snapshot && state.target) {
        const changed = await getChangedFiles(state.snapshot, state.root)
        const hasChanges = changed.modified.length > 0 || changed.added.length > 0 || changed.deleted.length > 0

        if (hasChanges) {
          const applyErrors = await applyBack(state, changed)
          let deletionErrors = ""
          if (changed.deleted.length > 0) {
            const approved = await askDeletionApproval(state.session, changed.deleted)
            if (approved) {
              deletionErrors = await applyDeletions(state, changed.deleted)
            }
          }
          const totalErrors = [applyErrors, deletionErrors].filter(Boolean).join("; ")
          if (totalErrors) {
            await write(state, "apply_back_partial", totalErrors)
          } else {
            await write(state, "applied_back", `modified: ${changed.modified.length}, added: ${changed.added.length}, deleted: ${changed.deleted.length}`)
          }
        } else {
          await write(state, "no_changes", "no file changes detected")
        }
      }

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
