interface PlaceholderProps {
  title: string;
  description: string;
}

export function Placeholder({ title, description }: PlaceholderProps) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{description}</p>
      <div className="empty-state">Not implemented yet — this view is a placeholder.</div>
    </section>
  );
}
