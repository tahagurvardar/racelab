import type { Ref } from "react";
import type { SessionListRow } from "../../session-workspace.ts";
import { Badge } from "./parts";

export function SessionRow({
  row,
  game,
  gameId,
  selected,
  tabStop,
  onSelect,
  ref,
}: {
  row: SessionListRow;
  /// The game's display name.
  game: string;
  /// The game's identifier, for styling and tests.
  gameId?: string;
  selected: boolean;
  tabStop: boolean;
  onSelect: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      role="option"
      id={`session-option-${row.id}`}
      aria-selected={selected}
      aria-label={`${row.label}. ${game}.`}
      tabIndex={tabStop ? 0 : -1}
      className={`session-option${selected ? " is-selected" : ""}`}
      data-session={row.id}
      data-game={gameId}
      onClick={onSelect}
    >
      <span className="session-option-time">{row.time}</span>
      <span className="session-option-vehicle">{row.vehicle}</span>
      <span className="session-option-duration">{row.duration}</span>
      <span className="session-option-meta">
        <span>{game}</span>
        {row.badges.length === 0 ? (
          <span>Completed</span>
        ) : (
          row.badges.map((badge) => <Badge key={badge.key} badge={badge} />)
        )}
      </span>
    </div>
  );
}
