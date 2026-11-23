import { Link, useSearchParams } from "react-router-dom";

import { RulesBrowser } from "./RulesBrowser";

/** The rules reference as a page of its own (outside any fight). `?rule=prone` opens that entry. */
export function RulesPage() {
  const [params] = useSearchParams();
  return (
    <section className="page ttrpg-page">
      <p>
        <Link to="/ttrpg">All campaigns</Link>
      </p>
      <h1>Rules reference</h1>
      <p className="muted">
        The System Reference Document 5.1: conditions, turn order, actions, attacks, cover, movement, damage and
        healing, and resting. It works offline and nothing you read here is sent anywhere.
      </p>
      <RulesBrowser focusId={params.get("rule")} />
    </section>
  );
}
