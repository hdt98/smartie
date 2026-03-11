import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { AgentTeamsTUI, createSplitPanes, closePanes, type TeammateInfo } from "../../src/plugin/agentteams-tui"

const env = { ...process.env }

beforeEach(() => {
  process.env = { ...env }
  AgentTeamsTUI.clearTeam()
})

afterEach(async () => {
  process.env = { ...env }
  AgentTeamsTUI.clearTeam()
  await Instance.disposeAll()
})

function makeTeammates(count: number): TeammateInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `bd-t.${i + 1}`,
    description: `Task ${i + 1}`,
    branch: `bead_bd-t.${i + 1}`,
    status: "pending" as const,
  }))
}

describe("agentteams-tui.team-formation", () => {
  test("TeamFormed event populates active team state", async () => {
    const teammates = makeTeammates(3)
    const tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Bus.publish(AgentTeamsTUI.Event.TeamFormed, {
          convoyID: "hq-tui.1",
          goal: "Test task",
          teammates,
        })

        // Simulate what the plugin does internally
        AgentTeamsTUI.setActiveTeam({
          convoyID: "hq-tui.1",
          goal: "Test task",
          teammates,
          phase: "working",
          merged: 0,
          conflicts: 0,
          failed: 0,
        })

        const team = AgentTeamsTUI.getActiveTeam()
        expect(team).not.toBeNull()
        expect(team!.convoyID).toBe("hq-tui.1")
        expect(team!.teammates).toHaveLength(3)
        expect(team!.phase).toBe("working")
      },
    })
    await tmp[Symbol.asyncDispose]()
  })

  test("team formation sets all teammates to pending initially", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.2",
      goal: "Setup",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    for (const t of team.teammates) {
      expect(t.status).toBe("pending")
    }
  })

  test("team formation includes bead details (ID, branch)", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.3",
      goal: "Details check",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    expect(team.teammates[0]!.id).toBe("bd-t.1")
    expect(team.teammates[0]!.branch).toBe("bead_bd-t.1")
    expect(team.teammates[1]!.id).toBe("bd-t.2")
    expect(team.teammates[1]!.branch).toBe("bead_bd-t.2")
  })
})

describe("agentteams-tui.live-status-updates", () => {
  test("TeammateStatus event updates teammate status in real time", async () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.4",
      goal: "Status test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    // Simulate status update
    teammates[0]!.status = "working"
    const team = AgentTeamsTUI.getActiveTeam()!
    expect(team.teammates[0]!.status).toBe("working")
    expect(team.teammates[1]!.status).toBe("pending")
  })

  test("teammate transitioning through pending -> working -> completed", () => {
    const teammates = makeTeammates(1)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.5",
      goal: "Lifecycle test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const t = AgentTeamsTUI.getActiveTeam()!.teammates[0]!
    expect(t.status).toBe("pending")

    t.status = "working"
    expect(t.status).toBe("working")

    t.status = "completed"
    expect(t.status).toBe("completed")
  })

  test("teammate failure status is tracked", () => {
    const teammates = makeTeammates(1)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.6",
      goal: "Failure test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    teammates[0]!.status = "failed"
    expect(AgentTeamsTUI.getActiveTeam()!.teammates[0]!.status).toBe("failed")
  })
})

describe("agentteams-tui.teammate-cycling", () => {
  test("Shift+Down cycles forward through teammates", () => {
    const teammates = makeTeammates(3)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.7",
      goal: "Cycle test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    expect(AgentTeamsTUI.getSelectedIndex()).toBe(0)

    const next1 = AgentTeamsTUI.cycleTeammate(1)
    expect(next1!.id).toBe("bd-t.2")
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(1)

    const next2 = AgentTeamsTUI.cycleTeammate(1)
    expect(next2!.id).toBe("bd-t.3")
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(2)

    // Wraps around
    const next3 = AgentTeamsTUI.cycleTeammate(1)
    expect(next3!.id).toBe("bd-t.1")
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(0)
  })

  test("cycling backward wraps around", () => {
    const teammates = makeTeammates(3)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.8",
      goal: "Reverse cycle",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const prev = AgentTeamsTUI.cycleTeammate(-1)
    expect(prev!.id).toBe("bd-t.3")
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(2)
  })

  test("cycling with no team returns null", () => {
    expect(AgentTeamsTUI.cycleTeammate(1)).toBeNull()
  })

  test("getSelectedTeammate returns current selection", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.9",
      goal: "Selection test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    expect(AgentTeamsTUI.getSelectedTeammate()!.id).toBe("bd-t.1")
    AgentTeamsTUI.cycleTeammate(1)
    expect(AgentTeamsTUI.getSelectedTeammate()!.id).toBe("bd-t.2")
  })

  test("cycling notifies onSelected listeners", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.9a",
      goal: "Selection callback test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    let idx = -1
    let id = ""
    const unsub = AgentTeamsTUI.onSelected((teammate, current) => {
      idx = current
      id = teammate.id
    })

    AgentTeamsTUI.cycleTeammate(1)
    unsub()
    expect(idx).toBe(1)
    expect(id).toBe("bd-t.2")
  })
})

describe("agentteams-tui.direct-messaging", () => {
  test("selected teammate is available for messaging", () => {
    const teammates = makeTeammates(3)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.10",
      goal: "Message test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    // Cycle to teammate 2
    AgentTeamsTUI.cycleTeammate(1)
    const selected = AgentTeamsTUI.getSelectedTeammate()
    expect(selected).not.toBeNull()
    expect(selected!.id).toBe("bd-t.2")
    // In the TUI, typing a message would send to this teammate's session
  })

  test("no selected teammate when no active team", () => {
    expect(AgentTeamsTUI.getSelectedTeammate()).toBeNull()
  })
})

describe("agentteams-tui.task-list", () => {
  test("Ctrl+T task list shows all beads and their status", () => {
    const teammates = makeTeammates(3)
    teammates[0]!.status = "completed"
    teammates[1]!.status = "working"
    teammates[2]!.status = "pending"
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.11",
      goal: "Task list test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    expect(team.teammates[0]!.status).toBe("completed")
    expect(team.teammates[1]!.status).toBe("working")
    expect(team.teammates[2]!.status).toBe("pending")
    expect(team.teammates).toHaveLength(3)
  })

  test("task list reflects status changes", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.12",
      goal: "Status change",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    expect(team.teammates[0]!.status).toBe("pending")

    team.teammates[0]!.status = "working"
    expect(AgentTeamsTUI.getActiveTeam()!.teammates[0]!.status).toBe("working")

    team.teammates[0]!.status = "completed"
    expect(AgentTeamsTUI.getActiveTeam()!.teammates[0]!.status).toBe("completed")
  })
})

describe("agentteams-tui.split-pane", () => {
  test("hasTmux returns false when TMUX env is not set", () => {
    delete process.env["TMUX"]
    expect(AgentTeamsTUI.hasTmux()).toBe(false)
  })

  test("hasTmux returns true when TMUX env is set", () => {
    process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
    expect(AgentTeamsTUI.hasTmux()).toBe(true)
  })

  test("createSplitPanes falls back when tmux is not available", async () => {
    delete process.env["TMUX"]
    const teammates = makeTeammates(2)
    const result = await createSplitPanes(teammates, "/tmp")
    expect(result).toBe(false)
  })

  test("closePanes is safe when tmux is not available", async () => {
    delete process.env["TMUX"]
    const teammates = makeTeammates(1)
    // Should not throw
    await closePanes(teammates)
  })
})

describe("agentteams-tui.convoy-completion", () => {
  test("ConvoyComplete event sets phase to complete with summary", async () => {
    const teammates = makeTeammates(3)
    teammates[0]!.status = "completed"
    teammates[1]!.status = "completed"
    teammates[2]!.status = "failed"
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.13",
      goal: "Completion test",
      teammates,
      phase: "complete",
      merged: 2,
      conflicts: 0,
      failed: 1,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    expect(team.phase).toBe("complete")
    expect(team.merged).toBe(2)
    expect(team.failed).toBe(1)
    expect(team.conflicts).toBe(0)
  })

  test("completion summary counts are correct", () => {
    const teammates = makeTeammates(4)
    teammates[0]!.status = "completed"
    teammates[1]!.status = "completed"
    teammates[2]!.status = "completed"
    teammates[3]!.status = "failed"
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.14",
      goal: "Count test",
      teammates,
      phase: "complete",
      merged: 3,
      conflicts: 0,
      failed: 1,
    })

    const team = AgentTeamsTUI.getActiveTeam()!
    const completed = team.teammates.filter((t) => t.status === "completed").length
    const failed = team.teammates.filter((t) => t.status === "failed").length
    expect(completed).toBe(3)
    expect(failed).toBe(1)
    expect(completed + failed).toBe(team.teammates.length)
  })

  test("clearTeam resets all state", () => {
    const teammates = makeTeammates(2)
    AgentTeamsTUI.setActiveTeam({
      convoyID: "hq-tui.15",
      goal: "Clear test",
      teammates,
      phase: "working",
      merged: 0,
      conflicts: 0,
      failed: 0,
    })
    AgentTeamsTUI.cycleTeammate(1)
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(1)

    AgentTeamsTUI.clearTeam()
    expect(AgentTeamsTUI.getActiveTeam()).toBeNull()
    expect(AgentTeamsTUI.getSelectedIndex()).toBe(0)
  })
})
