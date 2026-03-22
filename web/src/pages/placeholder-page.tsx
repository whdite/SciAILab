type PlaceholderPageProps = {
  title: string;
  body: string;
};

export function PlaceholderPage({ title, body }: PlaceholderPageProps) {
  return (
    <section className="page-card">
      <div className="page-card__header">
        <div>
          <div className="eyebrow">Coming Next</div>
          <h2>{title}</h2>
        </div>
      </div>
      <p className="muted-copy">{body}</p>
    </section>
  );
}
