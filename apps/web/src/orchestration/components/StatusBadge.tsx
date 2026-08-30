import type { StatusPresentation } from "../view-model";

/**
 * Status is communicated by an icon glyph and a text label as well as by
 * colour, so the panel stays readable without colour perception.
 */
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

export function BulletList({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) {
    return <p className="orch-note">{empty ?? "None recorded."}</p>;
  }
  return (
    <ul className="orch-list">
      {items.map((item, index) => (
        <li key={index + ":" + item.slice(0, 40)}>{item}</li>
      ))}
    </ul>
  );
}
