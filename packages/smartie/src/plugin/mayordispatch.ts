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
            beads: ids.map((id) => ({ id, branch: "", attempts: 0, status: "pending" as const })),
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
    },
  }
}
