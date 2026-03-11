import os from "os"
import path from "path"
import z from "zod"
import type { Plugin } from "@smartie-code/plugin"
import { Process } from "@/util/process"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"

type RunResult = {
  code: number
  stdout: string
  stderr: string
}

export type TeammateInfo = {
  id: string
  description: string
  branch: string
  status: "pending" | "working" | "completed" | "failed"
}

export type TeamState = {
  convoyID: string
  goal: string
  teammates: TeammateInfo[]
  phase: "forming" | "dispatching" | "working" | "complete"
  merged: number
  conflicts: number
  failed: number
}

export namespace AgentTeamsTUI {
  export const Event = {
    TeamFormed: BusEvent.define(
      "agentteams.team.formed",
      z.object({
        convoyID: z.string(),
        goal: z.string(),
        teammates: z.array(
          z.object({
            id: z.string(),
            description: z.string(),
            branch: z.string(),
            status: z.enum(["pending", "working", "completed", "failed"]),
          }),
        ),
      }),
    ),
    TeammateStatus: BusEvent.define(
      "agentteams.teammate.status",
      z.object({
        convoyID: z.string(),
        teammateID: z.string(),
        status: z.enum(["pending", "working", "completed", "failed"]),
      }),
    ),
    ConvoyComplete: BusEvent.define(
      "agentteams.convoy.complete",
      z.object({
        convoyID: z.string(),
        merged: z.number(),
        conflicts: z.number(),
        failed: z.number(),
        total: z.number(),
      }),
    ),
    Dispatching: BusEvent.define(
      "agentteams.dispatching",
      z.object({
        convoyID: z.string(),
      }),
    ),
  }

  // Shared mutable state for active team — queried by TUI components
  let activeTeam: TeamState | null = null
  let selectedIndex = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  const selected = new Set<(teammate: TeammateInfo, index: number) => void>()

  export function getActiveTeam(): TeamState | null {
    return activeTeam
  }

  export function getSelectedIndex(): number {
    return selectedIndex
  }

  export function cycleTeammate(direction: number): TeammateInfo | null {
    if (!activeTeam || activeTeam.teammates.length === 0) return null
    selectedIndex = (selectedIndex + direction + activeTeam.teammates.length) % activeTeam.teammates.length
    const mate = activeTeam.teammates[selectedIndex]!
    for (const cb of selected) cb(mate, selectedIndex)
    return mate
  }

  export function getSelectedTeammate(): TeammateInfo | null {
    if (!activeTeam || activeTeam.teammates.length === 0) return null
    return activeTeam.teammates[selectedIndex] ?? null
  }

  export function setActiveTeam(team: TeamState | null) {
    activeTeam = team
    selectedIndex = 0
  }

  export function clearTeam() {
    activeTeam = null
    selectedIndex = 0
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  export function startPolling(fn: () => void) {
    if (pollTimer) return
    pollTimer = setInterval(fn, 5000)
  }

  export function onSelected(cb: (teammate: TeammateInfo, index: number) => void) {
    selected.add(cb)
    return () => selected.delete(cb)
  }

  export function hasTmux(): boolean {
    return !!process.env["TMUX"]
  }
}

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

function enabled() {
  const value = process.env["SMARTIE_AGENT_TEAMS"]?.toLowerCase()
  return value === "1" || value === "true"
}

export const AgentTeamsTUIPlugin: Plugin = async (input) => {
  if (!enabled()) return {}

  // Track dispatched convoys for polling
  const trackedConvoys = new Set<string>()

  async function pollConvoyStatus(convoyID: string) {
    const result = await run(["gt", "convoy", "beads", convoyID], input.directory)
    if (result.code !== 0) return

    const ids = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)

    const team = AgentTeamsTUI.getActiveTeam()
    if (!team || team.convoyID !== convoyID) return

    for (const id of ids) {
      const status = await run(["gt", "bead", "status", id], input.directory)
      if (status.code !== 0) continue
      const parsed = status.stdout.trim().toLowerCase()
      const teammate = team.teammates.find((t) => t.id === id)
      if (!teammate) continue

      let newStatus: TeammateInfo["status"] = teammate.status
      if (parsed === "running" || parsed === "in_progress") newStatus = "working"
      else if (parsed === "closed" || parsed === "done") newStatus = "completed"
      else if (parsed === "failed") newStatus = "failed"
      else if (parsed === "pending" || parsed === "open") newStatus = "pending"

      if (newStatus !== teammate.status) {
        teammate.status = newStatus
        Bus.publish(AgentTeamsTUI.Event.TeammateStatus, {
          convoyID,
          teammateID: id,
          status: newStatus,
        })
      }
    }

    // Check if all teammates are done
    const allDone = team.teammates.every((t) => t.status === "completed" || t.status === "failed")
    if (allDone && team.phase !== "complete") {
      team.phase = "complete"
      const merged = team.teammates.filter((t) => t.status === "completed").length
      const failed = team.teammates.filter((t) => t.status === "failed").length
      team.merged = merged
      team.failed = failed
      Bus.publish(AgentTeamsTUI.Event.ConvoyComplete, {
        convoyID,
        merged,
        conflicts: team.conflicts,
        failed,
        total: team.teammates.length,
      })
      trackedConvoys.delete(convoyID)
    }
  }

  // Subscribe to agent_team_create tool completion to track convoys
  Bus.subscribeAll(async (event) => {
    // Listen for tool completions that indicate a convoy was created
    if (event.type !== "session.message.part.updated") return
    const part = event.properties?.part
    if (!part || part.type !== "tool") return
    if (part.tool !== "agent_team_create") return
    if (part.state?.status !== "completed") return

    // Parse convoy ID from the tool output
    const output = typeof part.state?.output === "string" ? part.state.output : ""
    const convoyMatch = output.match(/convoy\s+(\S+)/i)
    if (!convoyMatch) return
    const convoyID = convoyMatch[1]!

    // Parse bead IDs from output
    const beadMatch = output.match(/Beads:\s*(.+)/i)
    const beadIds = beadMatch ? beadMatch[1]!.split(",").map((b) => b.trim()).filter(Boolean) : []

    // Build team state
    const teamState: TeamState = {
      convoyID,
      goal: "",
      teammates: beadIds.map((id) => ({
        id,
        description: id,
        branch: `bead_${id}`,
        status: "pending" as const,
      })),
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    }

    // Set as active team
    AgentTeamsTUI.setActiveTeam(teamState)

    Bus.publish(AgentTeamsTUI.Event.TeamFormed, {
      convoyID,
      goal: teamState.goal,
      teammates: teamState.teammates,
    })

    // Start polling
    trackedConvoys.add(convoyID)
    AgentTeamsTUI.startPolling(() => {
      for (const id of trackedConvoys) {
        pollConvoyStatus(id)
      }
    })
  })

  return {
    tool: {
      // Expose team state to TUI via a read-only query tool
      agent_team_status: {
        description: "Query the current Agent Team status — shows convoy progress, teammate status, and completion details.",
        args: {},
        async execute() {
          const team = AgentTeamsTUI.getActiveTeam()
          if (!team) return "No active Agent Team."
          const lines = [
            `Convoy: ${team.convoyID}`,
            `Phase: ${team.phase}`,
            `Teammates:`,
          ]
          for (const t of team.teammates) {
            lines.push(`  ${t.id} [${t.status}] branch:${t.branch}`)
          }
          if (team.phase === "complete") {
            lines.push(`Result: ${team.merged} merged, ${team.conflicts} conflicts, ${team.failed} failed`)
          }
          return lines.join("\n")
        },
      },
    },
  }
}

/**
 * Create tmux split panes for each teammate.
 * Falls back silently if tmux is not available.
 */
export async function createSplitPanes(teammates: TeammateInfo[], cwd: string): Promise<boolean> {
  if (!AgentTeamsTUI.hasTmux()) return false

  for (const teammate of teammates) {
    const result = await run(
      ["tmux", "split-window", "-h", "-t", "", "-c", cwd, "echo", `Teammate ${teammate.id} [${teammate.branch}]`],
      cwd,
    )
    if (result.code !== 0) return false
  }

  // Even out the layout
  await run(["tmux", "select-layout", "tiled"], cwd)
  return true
}

/**
 * Close tmux panes for completed teammates.
 */
export async function closePanes(teammates: TeammateInfo[]): Promise<void> {
  if (!AgentTeamsTUI.hasTmux()) return
  // In a real implementation, we'd track pane IDs and close specific panes.
  // For now, this is a no-op placeholder — panes self-close when their commands exit.
  void teammates
}
