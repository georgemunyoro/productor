import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENT_NAMES, type AgentKind, type PermissionRequest } from "../types";

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** A tool the agent may only run with the user's say-so. */
function PermissionCard(props: { request: PermissionRequest; agent: AgentKind; onAnswer: (allow: boolean) => void }) {
  const { request, agent, onAnswer } = props;
  const detail =
    typeof request.input.command === "string"
      ? request.input.command
      : JSON.stringify(request.input, null, 2);
  return (
    <div className="permission">
      <div className="permission-title">
        {AGENT_NAMES[agent]} wants to run {request.toolName}
      </div>
      <pre>{detail}</pre>
      <div className="permission-actions">
        <button className="button" onClick={() => onAnswer(false)}>
          Deny
        </button>
        <button className="button primary" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}

/** A plan the agent has drawn up and wants approved before it starts. */
function PlanCard(props: { request: PermissionRequest; onAnswer: (allow: boolean) => void }) {
  const plan = typeof props.request.input.plan === "string" ? props.request.input.plan : "";
  return (
    <div className="permission plan">
      <div className="permission-title">Plan ready for your approval</div>
      <div className="prose plan-text">
        <Markdown remarkPlugins={[remarkGfm]}>{plan}</Markdown>
      </div>
      <div className="permission-actions">
        <button
          className="button"
          title="Stay in plan mode; tell the agent what to change"
          onClick={() => props.onAnswer(false)}
        >
          Keep planning
        </button>
        <button className="button primary" onClick={() => props.onAnswer(true)}>
          Approve and start
        </button>
      </div>
    </div>
  );
}

/** Questions the agent is asking; each takes a listed option or a typed answer. */
function QuestionCard(props: {
  request: PermissionRequest;
  onAnswer: (answers: Record<string, string>) => void;
  onDismiss: () => void;
}) {
  const questions = (props.request.input.questions as Question[] | undefined) ?? [];
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const answerFor = (q: Question) => typed[q.question]?.trim() || (chosen[q.question] ?? []).join(", ");
  const complete = questions.every((q) => answerFor(q));

  const pick = (q: Question, label: string) => {
    const current = chosen[q.question] ?? [];
    const next = q.multiSelect
      ? current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
      : [label];
    setChosen({ ...chosen, [q.question]: next });
    setTyped({ ...typed, [q.question]: "" });
  };

  return (
    <div className="permission question">
      {questions.map((q) => (
        <fieldset key={q.question}>
          <legend className="permission-title">{q.question}</legend>
          <div className="question-options">
            {q.options.map((option) => {
              const on = (chosen[q.question] ?? []).includes(option.label) && !typed[q.question];
              return (
                <button
                  key={option.label}
                  type="button"
                  className={"question-option" + (on ? " selected" : "")}
                  aria-pressed={on}
                  onClick={() => pick(q, option.label)}
                >
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            aria-label={`Another answer to: ${q.question}`}
            placeholder="Or type another answer…"
            value={typed[q.question] ?? ""}
            onChange={(e) => setTyped({ ...typed, [q.question]: e.target.value })}
          />
        </fieldset>
      ))}
      <div className="permission-actions">
        <button className="button" title="Decline to answer" onClick={props.onDismiss}>
          Skip
        </button>
        <button
          className="button primary"
          disabled={!complete}
          onClick={() => props.onAnswer(Object.fromEntries(questions.map((q) => [q.question, answerFor(q)])))}
        >
          Answer
        </button>
      </div>
    </div>
  );
}

/** Whatever the agent is waiting on the user for. */
export function RequestCard(props: {
  request: PermissionRequest;
  agent: AgentKind;
  onRespond: (allow: boolean) => void;
  onAnswer: (answers: Record<string, string>) => void;
}) {
  const { request, agent, onRespond, onAnswer } = props;
  if (request.toolName === "AskUserQuestion") {
    return <QuestionCard request={request} onAnswer={onAnswer} onDismiss={() => onRespond(false)} />;
  }
  if (request.toolName === "ExitPlanMode") return <PlanCard request={request} onAnswer={onRespond} />;
  return <PermissionCard request={request} agent={agent} onAnswer={onRespond} />;
}
