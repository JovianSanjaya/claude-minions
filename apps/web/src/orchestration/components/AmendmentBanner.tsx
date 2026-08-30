import type { ContractAmendment } from "../contracts";

export interface AmendmentBannerProps {
  amendment: ContractAmendment;
  onConfirm: () => void;
  onReject: () => void;
  busy: boolean;
}

export function AmendmentBanner({ amendment, onConfirm, onReject, busy }: AmendmentBannerProps) {
  return (
    <section className="orch-amendment-banner" role="alert" aria-labelledby="orch-amendment-heading">
      <h3 id="orch-amendment-heading">The confirmed contract needs to change</h3>
      <p>{amendment.reason}</p>
      {amendment.proposedIntent.requirements.length > 0 && (
        <div className="orch-claim-group">
          <h4>Proposed requirements</h4>
          <ul>
            {amendment.proposedIntent.requirements.map((claim) => (
              <li key={claim.id}>
                {claim.text} <span className="orch-provenance-tag">({claim.provenance})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="orch-amendment-actions">
        <button type="button" className="button button-primary" disabled={busy} onClick={onConfirm}>
          Confirm amendment
        </button>
        <button type="button" className="button button-ghost" disabled={busy} onClick={onReject}>
          Reject — keep the original contract
        </button>
      </div>
    </section>
  );
}
