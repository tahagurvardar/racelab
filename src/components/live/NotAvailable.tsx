export interface AbsentItem {
  key: string;
  label: string;
  note?: string;
  /// Omitted when the field already has a reading on screen (gear): the note
  /// is explained here without counting the field twice.
  source?: string;
  role?: string;
}

/// Fields RaceLab deliberately does not present, and why — quiet, grouped by
/// reason, at the foot of the tab. Honest without giving a missing value the
/// space of a real one.
export function NotAvailable({ items }: { items: AbsentItem[] }) {
  const groups = new Map<string, AbsentItem[]>();
  for (const item of items) {
    const reason = item.note ?? "Not available.";
    groups.set(reason, [...(groups.get(reason) ?? []), item]);
  }
  if (groups.size === 0) return null;
  return (
    <section className="not-available" aria-label="Not available">
      <h2 className="live-section-title">Not available</h2>
      <dl>
        {[...groups].map(([reason, group]) => (
          <div key={reason} className="not-available-group">
            <dt>
              {group.map((item, index) => (
                <span key={item.key}>
                  {index > 0 ? " · " : null}
                  <span
                    data-source={item.source}
                    data-role={item.source ? (item.role ?? "home") : undefined}
                    data-available={item.source ? false : undefined}
                  >
                    {item.label}
                  </span>
                </span>
              ))}
            </dt>
            <dd>{reason}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
