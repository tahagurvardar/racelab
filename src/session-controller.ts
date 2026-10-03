/// The Sessions workspace's data: the recent-sessions listing, the selected
/// session and its analysis, and the one bounded refresh the analysis needs.
///
/// Plain TypeScript with no React import, so every ordering rule below is
/// tested under Node with a scripted backend and scripted timers.
///
/// The rules:
///
/// 1. **A reply belongs to the request that asked for it.** Every selection
///    gets a new generation. A manifest or analysis reply is applied only if
///    its generation is still current *and* it is the newest read of its kind
///    in that generation. An analysis must name the selected session both in
///    its state *and* in the analysis document it carries. Choosing A, then B,
///    then C can therefore never show A's late reply under C, and the manifest
///    and analysis on screen always describe one session.
/// 2. **One analysis lane per selection.** At most one analysis read or re-run
///    request is in flight for the selected session. A read asked for while
///    one is in flight is folded into a single follow-up read issued after it
///    returns, so reads never overlap and the last read always starts after
///    the last request. The lane owns the only refresh timer: it is cleared
///    before every read and every re-run, scheduled only by a settled read
///    that is not superseded, and never while a re-run is outstanding.
/// 3. **One bounded refresh, for one session.** While the selected session's
///    analysis is `queued` or `analyzing`, it is read again every
///    `ANALYSIS_REFRESH_MS`. Any other state, a failed read, a new selection
///    or `dispose()` stops it. Nothing else is polled: no hidden session, no
///    list, no global loop.
/// 4. **Metadata only.** The backend commands used here return manifests and
///    analysis documents. There is no command that returns frames, and no type
///    here that could hold one.
/// 5. **One history, two games** (V2.0 Phase D). An F1 25 session is selected
///    like any other, but it has no FH6 analysis: selecting one reads its
///    factual detail (`get_f1_session`) under the same generation rule and
///    opens no analysis lane and no refresh timer.
import type { SessionAnalysisState } from "./analysis-state.ts";
import {
  orderSessions,
  type RecentSessions,
  type SessionManifest,
  type StorageStatus,
} from "./session-state.ts";
import { createStore, type Store } from "./state/stores.ts";
import type {
  F1SessionDetail,
  GameFilter,
  SessionGameId,
} from "./f1-sessions.ts";

/// Exactly as V1.0 listed sessions. Pagination is out of scope for V1.1.
export const RECENT_LIMIT = 20;

/// The approved D2(b) refresh interval for an analysis that is on its way.
export const ANALYSIS_REFRESH_MS = 2000;

export type DetailTab = "summary" | "events" | "turns" | "slip" | "data";

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "events", label: "Events" },
  { id: "turns", label: "Turns" },
  { id: "slip", label: "Slip" },
  { id: "data", label: "Data" },
];

/// F1 25's detail tabs. Factual only: no FH6 analysis concept (turns, slip)
/// is applied to F1 25.
export type F1DetailTab = "summary" | "laps" | "events" | "data";

export const F1_DETAIL_TABS: { id: F1DetailTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "laps", label: "Laps" },
  { id: "events", label: "Events" },
  { id: "data", label: "Data" },
];

/// The IPC commands Sessions uses, as functions, so tests can script replies
/// and their order. `invokeBackend` in the hook maps each to the same Tauri
/// command V1.0 called.
export interface SessionsBackend {
  listRecent(limit: number): Promise<RecentSessions>;
  storageStatus(): Promise<StorageStatus>;
  session(sessionId: string): Promise<SessionManifest>;
  analysis(sessionId: string): Promise<SessionAnalysisState>;
  reanalyze(sessionId: string): Promise<unknown>;
  /// F1 25 session detail. Absent on a backend without F1 25 sessions.
  f1Session?(sessionId: string): Promise<F1SessionDetail>;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const SYSTEM_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SessionsListState {
  recent: RecentSessions | null;
  storage: StorageStatus | null;
  error: string | null;
  /// True once the first listing reply (or failure) has arrived, so "loading"
  /// and "no sessions yet" are never the same screen.
  loaded: boolean;
}

export interface SelectedSession {
  id: string;
  /// Which game recorded it, from the listing. FH6 unless listed as F1 25.
  game: SessionGameId;
  /// F1 25 only: the session's factual detail, and its read state.
  f1: F1SessionDetail | null;
  f1Loading: boolean;
  f1Error: string | null;
  /// The manifest for `id`: the listed copy at first, replaced by a fresh read.
  /// Never another session's manifest.
  manifest: SessionManifest | null;
  manifestLoading: boolean;
  manifestError: string | null;
  /// The analysis state for `id`, or null until the first read arrives.
  analysis: SessionAnalysisState | null;
  analysisError: string | null;
  /// True until the first analysis read for `id` settles — with a state or
  /// with an error. Never left true by a failure.
  analysisLoading: boolean;
  /// True while the bounded refresh is scheduled or in flight.
  refreshing: boolean;
  reanalyzing: boolean;
  reanalyzeError: string | null;
}

export interface SessionsState {
  list: SessionsListState;
  selected: SelectedSession | null;
  tab: DetailTab;
  f1Tab: F1DetailTab;
  /// Presentation only: which game's sessions the list shows.
  filter: GameFilter;
}

/// What the workspace remembers while another section is open, so returning
/// to Sessions shows the same session on the same tab. Module scope on
/// purpose: the workspace unmounts when the user leaves it.
const memory: {
  id: string | null;
  tab: DetailTab;
  f1Tab: F1DetailTab;
  filter: GameFilter;
} = {
  id: null,
  tab: "summary",
  f1Tab: "summary",
  filter: "all",
};

export function resetSessionsMemory(): void {
  memory.id = null;
  memory.tab = "summary";
  memory.f1Tab = "summary";
  memory.filter = "all";
}

export interface SessionsController {
  store: Store<SessionsState>;
  /// Re-reads the listing (and storage status). Called on mount and when a
  /// recording completes. If a session is selected, its manifest — and its
  /// analysis, unless the refresh already covers it — are read again too.
  refreshList(): Promise<void>;
  /// Selects a session. Selecting the session already shown does nothing.
  select(sessionId: string): void;
  setTab(tab: DetailTab): void;
  setF1Tab(tab: F1DetailTab): void;
  setFilter(filter: GameFilter): void;
  /// Recovery only, exactly as V1.0 offered it: asks the backend to analyze
  /// the selected session again, then reads its new state (which starts the
  /// refresh if the job is queued).
  reanalyze(): Promise<void>;
  /// Cancels everything outstanding: replies still in flight are ignored and
  /// no refresh fires afterwards.
  dispose(): void;
}

function emptySelection(
  id: string,
  manifest: SessionManifest | null,
): SelectedSession {
  return {
    id,
    game: "fh6",
    f1: null,
    f1Loading: false,
    f1Error: null,
    manifest,
    manifestLoading: true,
    manifestError: null,
    analysis: null,
    analysisError: null,
    analysisLoading: true,
    refreshing: false,
    reanalyzing: false,
    reanalyzeError: null,
  };
}

interface Lane {
  gen: number;
  id: string;
  /// An analysis read is in flight.
  reading: boolean;
  /// A read was requested while one was in flight.
  again: boolean;
  /// A re-run request is in flight; no refresh is scheduled meanwhile.
  reanalyzing: boolean;
}

/// Why an analysis reply cannot be shown for `id`, or null if it can. The
/// state names a session, and so does the analysis document inside it; both
/// must be the selected one.
export function foreignAnalysis(
  reply: SessionAnalysisState,
  id: string,
): string | null {
  if (reply.session_id !== id) {
    return `The backend returned the analysis of session ${reply.session_id} for ${id}.`;
  }
  const embedded = reply.analysis?.session_id;
  if (reply.analysis != null && embedded !== id) {
    return `The analysis document for ${id} belongs to session ${embedded}.`;
  }
  return null;
}

/// Whether an analysis state is still on its way, and so worth reading again.
export function analysisPending(
  state: SessionAnalysisState | null | undefined,
): boolean {
  return state?.state === "queued" || state?.state === "analyzing";
}

export function createSessionsController(
  backend: SessionsBackend,
  timers: Timers = SYSTEM_TIMERS,
  refreshMs: number = ANALYSIS_REFRESH_MS,
): SessionsController {
  const store = createStore<SessionsState>({
    list: { recent: null, storage: null, error: null, loaded: false },
    selected: null,
    tab: memory.tab,
    f1Tab: memory.f1Tab,
    filter: memory.filter,
  });

  let disposed = false;
  let listSeq = 0;
  /// Bumped on every selection and on dispose; a reply from an older
  /// generation is dropped.
  let generation = 0;
  let manifestSeq = 0;
  /// The selected session's analysis lane; replaced on every selection.
  let lane: Lane | null = null;
  /// The one refresh timer. Only the current lane ever sets it.
  let timer: unknown = null;

  function clearTimer() {
    if (timer != null) timers.clear(timer);
    timer = null;
  }

  function current(gen: number): SelectedSession | null {
    if (disposed || gen !== generation) return null;
    return store.get().selected;
  }

  function patch(gen: number, change: Partial<SelectedSession>) {
    const selected = current(gen);
    if (selected == null) return;
    store.set({ ...store.get(), selected: { ...selected, ...change } });
  }

  function live(of: Lane): boolean {
    return !disposed && lane === of && of.gen === generation;
  }

  async function readManifest(gen: number, id: string) {
    const seq = ++manifestSeq;
    try {
      const manifest = await backend.session(id);
      if (current(gen) == null || seq !== manifestSeq) return;
      if (manifest.session_id !== id) {
        patch(gen, {
          manifestLoading: false,
          manifestError: `The backend returned session ${manifest.session_id} for ${id}.`,
        });
        return;
      }
      patch(gen, { manifest, manifestLoading: false, manifestError: null });
    } catch (reason) {
      if (current(gen) == null || seq !== manifestSeq) return;
      patch(gen, { manifestLoading: false, manifestError: String(reason) });
    }
  }

  let f1Seq = 0;

  function isF1(id: string): boolean {
    return (
      store
        .get()
        .list.recent?.f1_sessions?.some(
          (listing) => listing.session.racelab_session.session_id === id,
        ) ?? false
    );
  }

  /// F1 25 detail under the same rule as a manifest: only the newest read of
  /// the current generation lands, and it must name the selected session.
  async function readF1(gen: number, id: string) {
    const seq = ++f1Seq;
    if (backend.f1Session == null) {
      patch(gen, {
        f1Loading: false,
        f1Error: "This RaceLab backend cannot read F1 25 sessions.",
      });
      return;
    }
    try {
      const detail = await backend.f1Session(id);
      if (current(gen) == null || seq !== f1Seq) return;
      const named = detail.session.racelab_session.session_id;
      if (named !== id) {
        patch(gen, {
          f1Loading: false,
          f1Error: `The backend returned session ${named} for ${id}.`,
        });
        return;
      }
      patch(gen, { f1: detail, f1Loading: false, f1Error: null });
    } catch (reason) {
      if (current(gen) == null || seq !== f1Seq) return;
      patch(gen, { f1Loading: false, f1Error: String(reason) });
    }
  }

  /// Asks the lane for a fresh analysis read. Never starts a second read
  /// while one is in flight: the request is folded into one follow-up.
  function requestAnalysis(of: Lane) {
    if (!live(of)) return;
    clearTimer();
    if (of.reading) {
      of.again = true;
      return;
    }
    void readAnalysis(of);
  }

  async function readAnalysis(of: Lane) {
    of.reading = true;
    let reply: SessionAnalysisState | null = null;
    let failure: string | null = null;
    try {
      reply = await backend.analysis(of.id);
    } catch (reason) {
      failure = String(reason);
    }
    of.reading = false;
    if (!live(of)) return;

    if (failure == null && reply != null) {
      failure = foreignAnalysis(reply, of.id);
    }
    if (failure != null) {
      // A failed read stops the refresh: the failure is shown, not retried
      // behind the user's back.
      patch(of.gen, {
        analysisError: failure,
        analysisLoading: false,
        refreshing: false,
      });
    } else {
      patch(of.gen, {
        analysis: reply,
        analysisError: null,
        analysisLoading: false,
      });
    }

    if (of.again) {
      // Something asked for a newer read while this one was in flight. It
      // supersedes this reply's refresh decision.
      of.again = false;
      requestAnalysis(of);
      return;
    }
    const pending = failure == null && analysisPending(reply);
    if (pending && !of.reanalyzing) {
      clearTimer();
      timer = timers.set(() => {
        timer = null;
        requestAnalysis(of);
      }, refreshMs);
    }
    patch(of.gen, { refreshing: pending && !of.reanalyzing });
  }

  function select(id: string) {
    if (disposed) return;
    if (store.get().selected?.id === id) return;
    generation += 1;
    clearTimer();
    const gen = generation;
    const listed =
      store
        .get()
        .list.recent?.sessions.find((manifest) => manifest.session_id === id) ??
      null;
    memory.id = id;
    if (isF1(id)) {
      // No FH6 manifest, no analysis lane, no refresh timer.
      lane = null;
      store.set({
        ...store.get(),
        selected: {
          ...emptySelection(id, null),
          game: "f1_25",
          manifestLoading: false,
          analysisLoading: false,
          f1Loading: true,
        },
      });
      void readF1(gen, id);
      return;
    }
    store.set({ ...store.get(), selected: emptySelection(id, listed) });
    lane = { gen, id, reading: false, again: false, reanalyzing: false };
    void readManifest(gen, id);
    requestAnalysis(lane);
  }

  /// Every listed session of the filtered games, newest first, as ids.
  function listedIds(): string[] {
    const recent = store.get().list.recent;
    const filter = store.get().filter;
    const rows: { id: string; started: number }[] = [
      ...(filter === "f1_25" ? [] : orderSessions(recent?.sessions ?? [])).map(
        (manifest) => ({
          id: manifest.session_id,
          started: manifest.started_at_unix_ms ?? 0,
        }),
      ),
      ...(filter === "fh6" ? [] : (recent?.f1_sessions ?? [])).map(
        (listing) => ({
          id: listing.session.racelab_session.session_id,
          started: listing.session.racelab_session.started_at_unix_ms ?? 0,
        }),
      ),
    ];
    return rows
      .sort((a, b) => b.started - a.started || b.id.localeCompare(a.id))
      .map((row) => row.id);
  }

  async function refreshList() {
    if (disposed) return;
    const seq = ++listSeq;
    const [recent, storage] = await Promise.allSettled([
      backend.listRecent(RECENT_LIMIT),
      backend.storageStatus(),
    ]);
    if (disposed || seq !== listSeq) return;
    const previous = store.get().list;
    store.set({
      ...store.get(),
      list: {
        recent: recent.status === "fulfilled" ? recent.value : previous.recent,
        // Housekeeping status is additive: failing to read it never stops the
        // listing from rendering.
        storage: storage.status === "fulfilled" ? storage.value : null,
        error: recent.status === "rejected" ? String(recent.reason) : null,
        loaded: true,
      },
    });

    const ids = listedIds();
    const selected = store.get().selected;
    if (selected == null) {
      // Open the remembered session if it is still listed, else the newest.
      const first = ids.find((id) => id === memory.id) ?? ids[0];
      if (first) select(first);
      return;
    }
    if (selected.game === "f1_25") {
      // A completed recording may have finalized or recovered this session.
      void readF1(generation, selected.id);
      return;
    }
    // A completed recording may have changed the selected session itself
    // (finalized, recovered). Re-read it under the same selection. A pending
    // analysis is already covered by the refresh; a re-run in progress reads
    // the analysis itself when it returns.
    void readManifest(generation, selected.id);
    if (
      lane != null &&
      !lane.reanalyzing &&
      timer == null &&
      !analysisPending(selected.analysis)
    ) {
      requestAnalysis(lane);
    }
  }

  async function reanalyze() {
    const of = lane;
    if (of == null || !live(of) || of.reanalyzing) return;
    of.reanalyzing = true;
    clearTimer();
    patch(of.gen, {
      reanalyzing: true,
      reanalyzeError: null,
      refreshing: false,
    });
    let failure: string | null = null;
    try {
      await backend.reanalyze(of.id);
    } catch (reason) {
      failure = String(reason);
    }
    of.reanalyzing = false;
    if (!live(of)) return;
    patch(of.gen, { reanalyzing: false, reanalyzeError: failure });
    if (failure != null) {
      // Refused: the analysis on screen is still the truth. If it was on its
      // way, its refresh resumes through the lane.
      if (analysisPending(store.get().selected?.analysis)) requestAnalysis(of);
      return;
    }
    // Always a read issued after the re-run request returned.
    requestAnalysis(of);
  }

  function setTab(tab: DetailTab) {
    memory.tab = tab;
    if (store.get().tab !== tab) store.set({ ...store.get(), tab });
  }

  function setF1Tab(f1Tab: F1DetailTab) {
    memory.f1Tab = f1Tab;
    if (store.get().f1Tab !== f1Tab) store.set({ ...store.get(), f1Tab });
  }

  /// Shows one game's sessions, or all. A selection the filter hides is
  /// replaced by the newest visible session, so the detail never shows a
  /// session the list does not.
  function setFilter(filter: GameFilter) {
    if (disposed) return;
    memory.filter = filter;
    if (store.get().filter === filter) return;
    store.set({ ...store.get(), filter });
    const ids = listedIds();
    const selected = store.get().selected;
    if (ids.length === 0) {
      generation += 1;
      clearTimer();
      lane = null;
      memory.id = null;
      store.set({ ...store.get(), selected: null });
    } else if (selected == null || !ids.includes(selected.id)) {
      select(ids[0]);
    }
  }

  function dispose() {
    disposed = true;
    generation += 1;
    listSeq += 1;
    lane = null;
    clearTimer();
  }

  return {
    store,
    refreshList,
    select,
    setTab,
    setF1Tab,
    setFilter,
    reanalyze,
    dispose,
  };
}
