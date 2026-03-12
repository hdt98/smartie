import fs from "fs/promises"
import os from "os"
import path from "path"
import { tool, type Plugin } from "@smartie-code/plugin"
import { Process } from "@/util/process"

type RunResult = {
  code: number
  stdout: string
  stderr: string
}

type BeadStatus = {
  id: string
  branch: string
  attempts: number
  status: "pending" | "running" | "done" | "failed"
  merged: boolean
  conflict: boolean
}

type ConvoyState = {
  id: string
  beads: BeadStatus[]
  rig?: string
  root: string
  request?: string
  provider?: string
  model?: string
  runtime?: string
  authPath?: string
}

const MAX_RETRIES = 3

function home() {
  return process.env.HOME || os.homedir()
}

function binpath() {
  return [path.join(home(), "go", "bin"), path.join(home(), ".local", "bin"), process.env.PATH ?? ""].join(":")
}

async function run(cmd: string[], cwd: string): Promise<RunResult> {
  const out = await Process.run(cmd, {
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

function extractId(text: string) {
  return text.match(/\b[a-z]+-[a-z0-9.-]+\b/i)?.[0] ?? text.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
}

function reason(out: RunResult) {
  return out.stderr || out.stdout || "command failed without output"
}

function branchName(beadId: string) {
  return `bead_${beadId}`
}

export const MayorDispatchPlugin: Plugin = async (input) => {
  const convoys = new Map<string, ConvoyState>()

  async function branchExists(branch: string, cwd: string): Promise<boolean> {
    const check = await run(["git", "rev-parse", "--verify", branch], cwd)
    return check.code === 0
  }

  async function createBranch(beadId: string, cwd: string): Promise<{ ok: boolean; branch: string; error?: string }> {
    const branch = branchName(beadId)
    if (await branchExists(branch, cwd)) return { ok: true, branch }
    const worktree = await run(["git", "worktree", "add", "-b", branch, path.join(cwd, ".worktrees", branch)], cwd)
    if (worktree.code === 0) return { ok: true, branch }
    const fallback = await run(["git", "checkout", "-b", branch], cwd)
    if (fallback.code === 0) return { ok: true, branch }
    return { ok: false, branch, error: reason(fallback) }
  }

  async function spawnPolecat(
    beadId: string,
    branch: string,
    cwd: string,
    rig?: string,
    context?: {
      provider?: string
      model?: string
      runtime?: string
      authPath?: string
    },
  ): Promise<{ ok: boolean; error?: string }> {
    const cmd = ["gt", "sling", "create"]
    if (rig) cmd.push(rig)
    const model = context?.provider && context?.model ? `${context.provider}/${context.model}` : ""
    const launch = ["smartie", "run"]
    if (model) launch.push("--model", model)
    if (context?.runtime) launch.push("--agent", context.runtime)
    cmd.push("--bead", beadId, "--branch", branch, "--cmd", launch.join(" "), "--env", "SMARTIE_AGENT_TEAMS=0")
    if (context?.provider) cmd.push("--env", `SMARTIE_LEAD_PROVIDER=${context.provider}`)
    if (context?.model) cmd.push("--env", `SMARTIE_LEAD_MODEL=${context.model}`)
    if (context?.authPath) cmd.push("--env", `SMARTIE_AUTH_PATH=${context.authPath}`)
    const sling = await run(cmd, cwd)
    if (sling.code !== 0) return { ok: false, error: reason(sling) }
    return { ok: true }
  }

  async function markBead(beadId: string, status: string, cwd: string) {
    await run(["gt", "bead", "update", beadId, "--status", status], cwd)
  }

  async function dispatchBead(
    bead: BeadStatus,
    cwd: string,
    rig?: string,
    context?: {
      provider?: string
      model?: string
      runtime?: string
      authPath?: string
    },
  ): Promise<string | undefined> {
    const br = await createBranch(bead.id, cwd)
    if (!br.ok) return `Branch creation failed for ${bead.id}: ${br.error}`
    bead.branch = br.branch

    const spawn = await spawnPolecat(bead.id, br.branch, cwd, rig, context)
    if (!spawn.ok) return `Polecat spawn failed for ${bead.id}: ${spawn.error}`

    bead.status = "running"
    bead.attempts++
    return undefined
  }

  return {
    tool: {
      mayor_dispatch: tool({
        description:
          "Dispatch a Convoy: create isolated git branches per Bead, spawn Polecats via gt sling, and track progress. Each Polecat runs smartie headless with SMARTIE_AGENT_TEAMS=0. Failed Polecats are retried up to 3 times.",
        args: {
          convoy_id: tool.schema.string().describe("The convoy ID to dispatch."),
          rig: tool.schema.string().optional().describe("Request rig name for this convoy."),
          root: tool.schema.string().optional().describe("Request rig root directory."),
          request_id: tool.schema.string().optional().describe("Request ID for metadata linkage."),
          provider_id: tool.schema.string().optional().describe("Lead provider ID to inherit."),
          model_id: tool.schema.string().optional().describe("Lead model ID to inherit."),
          runtime: tool.schema.string().optional().describe("Lead runtime/agent to inherit."),
          auth_path: tool.schema.string().optional().describe("Shared auth store path."),
        },
        async execute(args, ctx) {
          if (args.rig) {
            const check = await run(["gt", "rig", "status", args.rig], input.directory)
            if (check.code !== 0) return `Dispatch failed: request rig ${args.rig} is unavailable. ${reason(check)}`
          }

          const root = args.root || input.directory
          if (args.auth_path) {
            const has = await fs
              .access(args.auth_path)
              .then(() => true)
              .catch(() => false)
            if (!has) return `Dispatch failed: auth inheritance path not found at ${args.auth_path}.`
          }
          const beadList = await run(["gt", "convoy", "beads", args.convoy_id], root)
          if (beadList.code !== 0) return `Dispatch failed: could not list beads for convoy ${args.convoy_id}. ${reason(beadList)}`

          const ids = beadList.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
          if (!ids.length) return `Dispatch failed: no beads found in convoy ${args.convoy_id}.`

          const state: ConvoyState = {
            id: args.convoy_id,
            rig: args.rig,
            root,
            request: args.request_id,
            provider: args.provider_id,
            model: args.model_id,
            runtime: args.runtime,
            authPath: args.auth_path,
            beads: ids.map((id) => ({ id, branch: "", attempts: 0, status: "pending" as const, merged: false, conflict: false })),
          }
          convoys.set(args.convoy_id, state)

          const errors: string[] = []
          for (const bead of state.beads) {
            const err = await dispatchBead(bead, state.root, state.rig, {
              provider: state.provider,
              model: state.model,
              runtime: state.runtime,
              authPath: state.authPath,
            })
            if (err) {
              bead.status = "failed"
              bead.attempts = 1
              await markBead(bead.id, "failed", state.root)
              errors.push(err)
            }
          }

          const running = state.beads.filter((b) => b.status === "running").length
          const failed = state.beads.filter((b) => b.status === "failed").length
          const lines = [
            `Dispatched convoy ${args.convoy_id}: ${running} of ${state.beads.length} Polecats spawned.`,
          ]
          if (failed) lines.push(`${failed} bead(s) failed to launch: ${errors.join("; ")}`)
          return lines.join("\n")
        },
      }),

      mayor_bead_complete: tool({
        description:
          "Called when a Polecat signals completion for a Bead. Marks the Bead as done and reports Convoy progress.",
        args: {
          convoy_id: tool.schema.string().describe("The convoy ID."),
          bead_id: tool.schema.string().describe("The bead ID that completed."),
          success: tool.schema.boolean().describe("Whether the Polecat succeeded."),
        },
        async execute(args, _ctx) {
          const state = convoys.get(args.convoy_id)
          if (!state) return `Unknown convoy: ${args.convoy_id}`

          const bead = state.beads.find((b) => b.id === args.bead_id)
          if (!bead) return `Unknown bead: ${args.bead_id} in convoy ${args.convoy_id}`

          if (args.success) {
            bead.status = "done"
            await markBead(bead.id, "closed", state.root)
          } else {
            if (bead.attempts < MAX_RETRIES) {
              const err = await dispatchBead(bead, state.root, state.rig, {
                provider: state.provider,
                model: state.model,
                runtime: state.runtime,
                authPath: state.authPath,
              })
              if (err) {
                bead.status = "failed"
                await markBead(bead.id, "failed", state.root)
              }
            } else {
              bead.status = "failed"
              await markBead(bead.id, "failed", state.root)
            }
          }

          const done = state.beads.filter((b) => b.status === "done").length
          const failed = state.beads.filter((b) => b.status === "failed").length
          const running = state.beads.filter((b) => b.status === "running").length
          return [
            `Convoy ${args.convoy_id}: ${done}/${state.beads.length} complete, ${running} running, ${failed} failed.`,
            bead.status === "failed" && bead.attempts >= MAX_RETRIES
              ? `Bead ${args.bead_id} exhausted ${MAX_RETRIES} retries — marked failed.`
              : bead.status === "failed"
                ? `Bead ${args.bead_id} failed to respawn.`
                : bead.status === "running"
                  ? `Bead ${args.bead_id} retrying (attempt ${bead.attempts}/${MAX_RETRIES}).`
                  : `Bead ${args.bead_id} done.`,
          ].join("\n")
        },
      }),

      mayor_convoy_merge: tool({
        description:
          "Merge completed Bead branches back to the working branch, close the Convoy, and signal the lead session. Merges in bead creation order. Conflict branches are preserved for manual resolution. Successful branches are cleaned up.",
        args: {
          convoy_id: tool.schema.string().describe("The convoy ID to merge."),
        },
        async execute(args, _ctx) {
          const state = convoys.get(args.convoy_id)
          if (!state) return `Unknown convoy: ${args.convoy_id}`

          const pending = state.beads.filter((b) => b.status === "running")
          if (pending.length) return `Cannot merge: ${pending.length} bead(s) still running in convoy ${args.convoy_id}.`

          const mainBranch = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], state.root)
          const target = mainBranch.stdout || "main"

          const merged: string[] = []
          const conflicts: string[] = []
          const failed: string[] = []

          for (const bead of state.beads) {
            if (bead.status === "failed") {
              failed.push(bead.id)
              continue
            }
            if (bead.status !== "done") continue
            if (!bead.branch) continue

            const merge = await run(["git", "merge", "--no-edit", bead.branch], state.root)
            if (merge.code !== 0) {
              await run(["git", "merge", "--abort"], state.root)
              bead.conflict = true
              conflicts.push(bead.id)
              continue
            }

            bead.merged = true
            merged.push(bead.id)

            await run(["git", "branch", "-d", bead.branch], state.root)
          }

          await run(["gt", "convoy", "close", args.convoy_id], state.root)

          const summary = [
            `Convoy ${args.convoy_id} merge complete.`,
            `Merged: ${merged.length}/${state.beads.length} beads.`,
          ]
          if (merged.length) summary.push(`Succeeded: ${merged.join(", ")}`)
          if (conflicts.length) summary.push(`Conflicts (branches preserved): ${conflicts.join(", ")}`)
          if (failed.length) summary.push(`Failed (branches preserved): ${failed.join(", ")}`)

          const signal = await run(
            [
              "gt",
              "signal",
              "convoy-complete",
              "--convoy",
              args.convoy_id,
              "--merged",
              String(merged.length),
              "--conflicts",
              String(conflicts.length),
              "--failed",
              String(failed.length),
              "--total",
              String(state.beads.length),
            ],
            state.root,
          )
          if (signal.code !== 0) summary.push(`Warning: lead session signal failed: ${reason(signal)}`)

          return summary.join("\n")
        },
      }),
    },
  }
}
