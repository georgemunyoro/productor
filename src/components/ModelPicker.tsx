import { useState } from "react";
import { useStore } from "../store";
import type { AgentKind, Chat } from "../types";

/** Model names each agent's CLI accepts as shorthand; others can be typed. */
const MODELS: Record<AgentKind, { id: string; label: string }[]> = {
  claude: [
    { id: "fable", label: "Fable" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [],
};

const CUSTOM = "__custom__";

/**
 * Chooses the agent, its model and whether it runs in fast mode. The agent
 * is fixed once the conversation starts; model and speed can change between
 * turns.
 */
export function ModelPicker(props: { chat: Chat; busy: boolean; onPickAgent?: (agent: AgentKind) => void }) {
  const { chat, busy, onPickAgent } = props;
  const defaults = useStore((s) => s.agentDefaults);
  // Set once Claude Code has turned fast mode down, with its reason.
  const refused = useStore((s) => (chat.agent === "claude" ? s.claudeFastRefused : null));
  const { setChatOptions } = useStore.getState();
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");

  const known = MODELS[chat.agent];
  const defaultModel = chat.agent === "claude" ? defaults.claudeModel : defaults.codexModel;
  // With nothing chosen, the agent's own configuration decides the speed.
  const fast = chat.fast ?? (chat.agent === "codex" ? defaults.codexFast : false);
  const isCustom = chat.model !== null && !known.some((m) => m.id === chat.model);

  const saveCustom = () => {
    const model = custom.trim();
    setTyping(false);
    if (model) void setChatOptions(chat, model, chat.fast);
  };

  return (
    <span className="model-picker">
      {onPickAgent ? (
        <select
          className="agent-picker"
          aria-label="Agent"
          value={chat.agent}
          disabled={busy}
          onChange={(e) => onPickAgent(e.target.value as AgentKind)}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      ) : (
        <span className="agent-label">{chat.agent === "claude" ? "Claude" : "Codex"}</span>
      )}
      {typing ? (
        <input
          className="agent-picker model-input"
          aria-label="Model name"
          autoFocus
          spellCheck={false}
          placeholder="Model name"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onBlur={saveCustom}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setTyping(false);
          }}
        />
      ) : (
        <select
          className="agent-picker"
          aria-label="Model"
          value={chat.model ?? ""}
          disabled={busy}
          title={busy ? "The model can be changed when the agent has finished its turn" : undefined}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(isCustom ? (chat.model ?? "") : "");
              setTyping(true);
            } else void setChatOptions(chat, e.target.value || null, chat.fast);
          }}
        >
          <option value="">{defaultModel ? `Default (${defaultModel})` : "Default model"}</option>
          {known.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {isCustom && <option value={chat.model!}>{chat.model}</option>}
          <option value={CUSTOM}>Other…</option>
        </select>
      )}
      <label
        className="fast-toggle"
        title={
          refused
            ? `Fast mode is not available: ${refused}.`
            : chat.agent === "claude"
              ? "Fast mode: faster output from Claude Opus, billed as extra usage."
              : "Fast mode: Codex's fast service tier."
        }
      >
        <input
          type="checkbox"
          checked={fast && !refused}
          disabled={busy || Boolean(refused)}
          onChange={(e) => setChatOptions(chat, chat.model, e.target.checked)}
        />
        Fast
      </label>
    </span>
  );
}
