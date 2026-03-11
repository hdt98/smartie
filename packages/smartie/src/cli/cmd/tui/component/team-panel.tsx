import { createSignal, For, Show, onCleanup } from "solid-js"
import { useTheme, selectedForeground } from "@tui/context/theme"
import { RGBA, TextAttributes } from "@opentui/core"
import { type JSX } from "@opentui/solid"
import { Bus } from "@/bus"
import { AgentTeamsTUI, type TeammateInfo } from "@/plugin/agentteams-tui"

const STATUS_ICONS: Record<TeammateInfo["status"], string> = {
  pending: "○",
  working: "◉",
  completed: "✓",
  failed: "✗",
}

const STATUS_LABELS: Record<TeammateInfo["status"], string> = {
  pending: "pending",
  working: "working",
  completed: "completed",
  failed: "failed",
}

export function TeamPanel(props: { width: number }): JSX.Element {
  const { theme } = useTheme()
  const [team, setTeam] = createSignal(AgentTeamsTUI.getActiveTeam())
  const [selected, setSelected] = createSignal(AgentTeamsTUI.getSelectedIndex())

  // Subscribe to team events
  const unsub1 = Bus.subscribe(AgentTeamsTUI.Event.TeamFormed, () => {
    setTeam(AgentTeamsTUI.getActiveTeam())
    setSelected(0)
  })
  const unsub2 = Bus.subscribe(AgentTeamsTUI.Event.TeammateStatus, () => {
    const next = AgentTeamsTUI.getActiveTeam()
    if (!next) return
    setTeam({ ...next })
  })
  const unsub3 = Bus.subscribe(AgentTeamsTUI.Event.ConvoyComplete, () => {
    const next = AgentTeamsTUI.getActiveTeam()
    if (!next) return
    setTeam({ ...next })
  })
  const unsub4 = AgentTeamsTUI.onSelected((_, idx) => {
    setSelected(idx)
  })

  onCleanup(() => {
    unsub1()
    unsub2()
    unsub3()
    unsub4()
  })

  function statusColor(status: TeammateInfo["status"]): RGBA {
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

  return (
    <Show when={team()}>
      {(t) => (
        <box height="auto" width={props.width}>
          {/* Header */}
          <box height={1}>
            <text
              content={`Agent Team ${t().phase === "complete" ? "(complete)" : ""}`}
              attributes={new TextAttributes({ bold: true, foreground: selectedForeground(theme) })}
            />
          </box>

          {/* Convoy ID */}
          <box height={1}>
            <text
              content={`Convoy: ${t().convoyID}`}
              attributes={new TextAttributes({ foreground: new RGBA(150, 150, 150, 255) })}
            />
          </box>

          {/* Teammate list */}
          <For each={t().teammates}>
            {(teammate, i) => {
              const isSelected = () => i() === selected()
              return (
                <box height={1}>
                  <text
                    content={`${isSelected() ? "▸ " : "  "}${STATUS_ICONS[teammate.status]} ${teammate.id} ${STATUS_LABELS[teammate.status]}`}
                    attributes={
                      new TextAttributes({
                        bold: isSelected(),
                        foreground: statusColor(teammate.status),
                      })
                    }
                  />
                </box>
              )
            }}
          </For>

          {/* Completion summary */}
          <Show when={t().phase === "complete"}>
            <box height={1}>
              <text content="" />
            </box>
            <box height={1}>
              <text
                content={`${t().merged} merged, ${t().conflicts} conflicts, ${t().failed} failed`}
                attributes={new TextAttributes({ foreground: new RGBA(200, 200, 200, 255) })}
              />
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}
