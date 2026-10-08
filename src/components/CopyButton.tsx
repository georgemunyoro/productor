import { useEffect, useState } from "react";
import { copyText } from "../clipboard";

/** A small button that copies text and briefly confirms it did. */
export function CopyButton(props: { text: string | (() => string); label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      className={"copy-button " + (props.className ?? "")}
      title={props.label ?? "Copy"}
      onClick={async () => {
        const text = typeof props.text === "function" ? props.text() : props.text;
        if (await copyText(text)) setCopied(true);
      }}
    >
      {copied ? "Copied" : (props.label ?? "Copy")}
    </button>
  );
}
