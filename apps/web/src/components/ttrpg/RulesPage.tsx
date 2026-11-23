import { Link, useSearchParams } from "react-router-dom";

import { RulesBrowser } from "./RulesBrowser";

/** The rules reference as a page of its own (outside any fight). `?rule=prone` opens that entry. */
export function RulesPage() {
  const [params] = useSearchParams();
  return (
    <section className="page">
      <p className="tt-crumb">
        <Link to="/ttrpg">All campaigns</Link>
      </p>
      <div className="tt-banner">
        <div>
          <h1>Rules reference</h1>
          <p className="sub">
            The System Reference Document 5.1: conditions, turn order, actions, attacks, cover, movement, damage and
            healing, and resting. It works offline and nothing you read here is sent anywhere.
          </p>
        </div>
      </div>
      <div className="tt-rule" aria-hidden="true" />
      <div className="tt-card">
        <RulesBrowser focusId={params.get("rule")} />
      </div>
    </section>
  );
}
