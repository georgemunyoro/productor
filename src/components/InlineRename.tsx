import { useRef, useState } from "react";

/**
 * A text field that replaces a label while it is being renamed. Enter or
 * clicking away saves; Escape cancels. `onDone` gets the new name, or null
 * if nothing should change.
 */
export function InlineRename(props: {
  value: string;
  label: string;
  className?: string;
  onDone: (value: string | null) => void;
}) {
  const [text, setText] = useState(props.value);
  // Cancelling removes the field, which some browsers follow with a blur;
  // that blur must not then save what was just cancelled.
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const trimmed = text.trim();
    props.onDone(save && trimmed && trimmed !== props.value ? trimmed : null);
  };
  return (
    <input
      className={props.className}
      aria-label={props.label}
      autoFocus
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") finish(false);
      }}
    />
  );
}
