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

  async function spawnPolecat(beadId: string, branch: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
    const sling = await run(
      [
        "gt",
        "sling",
        "create",
        "--bead",
        beadId,
        "--branch",
        branch,
        "--cmd",
        "smartie run",
        "--env",
        "SMARTIE_AGENT_TEAMS=0",
      ],
      cwd,
    )
    if (sling.code !== 0) return { ok: false, error: reason(sling) }
    return { ok: true }
  }

  async function markBead(beadId: string, status: string, cwd: string) {
    await run(["gt", "bead", "update", beadId, "--status", status], cwd)
  }

  async function dispatchBead(bead: BeadStatus, cwd: string): Promise<string | undefined> {
    const br = await createBranch(bead.id, cwd)
    if (!br.ok) return `Branch creation failed for ${bead.id}: ${br.error}`
    bead.branch = br.branch

    const spawn = await spawnPolecat(bead.id, br.branch, cwd)
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
        },
        async execute(args, ctx) {
          const beadList = await run(["gt", "convoy", "beads", args.convoy_id], input.directory)
          if (beadList.code !== 0) return `Dispatch failed: could not list beads for convoy ${args.convoy_id}. ${reason(beadList)}`

          const ids = beadList.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
          if (!ids.length) return `Dispatch failed: no beads found in convoy ${args.convoy_id}.`

          const state: ConvoyState = {
            id: args.convoy_id,
            beads: ids.map((id) => ({ id, branch: "", attempts: 0, status: "pending" as const, merged: false, conflict: false })),
          }
          convoys.set(args.convoy_id, state)

          const errors: string[] = []
          for (const bead of state.beads) {
            const err = await dispatchBead(bead, input.directory)
            if (err) {
              bead.status = "failed"
              bead.attempts = 1
              await markBead(bead.id, "failed", input.directory)
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
            await markBead(bead.id, "closed", input.directory)
          } else {
            if (bead.attempts < MAX_RETRIES) {
              const err = await dispatchBead(bead, input.directory)
              if (err) {
                bead.status = "failed"
                await markBead(bead.id, "failed", input.directory)
              }
            } else {
              bead.status = "failed"
              await markBead(bead.id, "failed", input.directory)
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

          const mainBranch = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], input.directory)
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

            const merge = await run(["git", "merge", "--no-edit", bead.branch], input.directory)
            if (merge.code !== 0) {
              await run(["git", "merge", "--abort"], input.directory)
              bead.conflict = true
              conflicts.push(bead.id)
              continue
            }

            bead.merged = true
            merged.push(bead.id)

            await run(["git", "branch", "-d", bead.branch], input.directory)
          }

          await run(["gt", "convoy", "close", args.convoy_id], input.directory)

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
            input.directory,
          )
          if (signal.code !== 0) summary.push(`Warning: lead session signal failed: ${reason(signal)}`)

          return summary.join("\n")
        },
      }),
    },
  }
}
