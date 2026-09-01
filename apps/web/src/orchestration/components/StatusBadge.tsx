import type { StatusPresentation } from "../view-model";

export function StatusBadge({
  presentation,
  title,
}: {
  presentation: StatusPresentation;
  title?: string;
}) {
  return (
    <span className="orch-status" data-tone={presentation.tone} title={title}>
      <span className="orch-status-icon" aria-hidden="true">
        {presentation.icon}
      </span>
      {presentation.label}
    </span>
  );
}

export function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="orch-fact">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

type DetailListKind = "requirement" | "assumption" | "non-goal" | "architecture" | "manual";

const DETAIL_MARKS: Record<DetailListKind, string> = {
  requirement: "✓",
  assumption: "≈",
  "non-goal": "−",
  architecture: "◇",
  manual: "↗",
};

export function DetailList({
  items,
  kind,
  empty,
}: {
  items: string[];
  kind: DetailListKind;
  empty?: string;
}) {
  if (items.length === 0) return <p className="orch-note">{empty ?? "None recorded."}</p>;
  return (
    <ol className="orch-detail-list" data-kind={kind}>
      {items.map((item, index) => (
        <li key={`${index}:${item.slice(0, 40)}`}>
          <span className="orch-detail-mark" aria-hidden="true">
            {DETAIL_MARKS[kind]}
          </span>
          <p>{item}</p>
        </li>
      ))}
    </ol>
  );
}
