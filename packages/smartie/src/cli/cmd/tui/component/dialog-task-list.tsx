import { createSignal, For, Show, onCleanup } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
import { type JSX } from "@opentui/solid"
import { Bus } from "@/bus"
import { AgentTeamsTUI, type TeammateInfo } from "@/plugin/agentteams-tui"

const STATUS_BADGE: Record<TeammateInfo["status"], string> = {
  pending: "[ PENDING ]",
  working: "[WORKING ▸]",
  completed: "[  DONE  ✓]",
  failed: "[FAILED  ✗]",
}

function badgeColor(status: TeammateInfo["status"]): RGBA {
  switch (status) {
    case "working":
      return new RGBA(100, 180, 255, 255)
    case "completed":
      return new RGBA(100, 220, 100, 255)
    case "failed":
      return new RGBA(255, 100, 100, 255)
    default:
      return new RGBA(150, 150, 150, 255)
  }
}

export function DialogTaskList(): JSX.Element {
  const [team, setTeam] = createSignal(AgentTeamsTUI.getActiveTeam())

  const unsub1 = Bus.subscribe(AgentTeamsTUI.Event.TeammateStatus, () => {
    setTeam({ ...AgentTeamsTUI.getActiveTeam()! })
  })
  const unsub2 = Bus.subscribe(AgentTeamsTUI.Event.ConvoyComplete, () => {
    setTeam({ ...AgentTeamsTUI.getActiveTeam()! })
  })

  onCleanup(() => {
    unsub1()
    unsub2()
  })

  return (
    <box width="100%" height="auto">
      <Show
        when={team()}
        fallback={
          <box height={1}>
            <text
              content="No active Agent Team"
              attributes={new TextAttributes({ foreground: new RGBA(150, 150, 150, 255) })}
            />
          </box>
        }
      >
        {(t) => (
          <box height="auto">
            {/* Title */}
            <box height={1}>
              <text
                content={`Task List — Convoy ${t().convoyID}`}
                attributes={new TextAttributes({ bold: true })}
              />
            </box>
            <box height={1}>
              <text content="" />
            </box>

            {/* Header row */}
            <box height={1}>
              <text
                content={`${"STATUS".padEnd(14)}${"BEAD ID".padEnd(20)}BRANCH`}
                attributes={new TextAttributes({ bold: true, foreground: new RGBA(180, 180, 180, 255) })}
              />
            </box>

            {/* Task rows */}
            <For each={t().teammates}>
              {(teammate) => (
                <box height={1}>
                  <text
                    content={`${STATUS_BADGE[teammate.status].padEnd(14)}${teammate.id.padEnd(20)}${teammate.branch}`}
                    attributes={new TextAttributes({ foreground: badgeColor(teammate.status) })}
                  />
                </box>
              )}
            </For>

            {/* Summary */}
            <box height={1}>
              <text content="" />
            </box>
            <box height={1}>
              <text
                content={(() => {
                  const tm = t().teammates
                  const done = tm.filter((x) => x.status === "completed").length
                  const working = tm.filter((x) => x.status === "working").length
                  const failed = tm.filter((x) => x.status === "failed").length
                  const pending = tm.filter((x) => x.status === "pending").length
                  return `${done}/${tm.length} complete | ${working} working | ${pending} pending | ${failed} failed`
                })()}
                attributes={new TextAttributes({ foreground: new RGBA(200, 200, 200, 255) })}
              />
            </box>
          </box>
        )}
      </Show>
    </box>
  )
}
