// A slow IPC/UI read never creates a backlog: schedule only after completion.
export function startLatestPolling<T>(
  read: () => Promise<T>,
  onValue: (value: T) => void,
  onError: (reason: unknown) => void,
  intervalMs = 50,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    try {
      const value = await read();
      if (!disposed) onValue(value);
    } catch (reason) {
      if (!disposed) onError(reason);
    } finally {
      if (!disposed)
        timer = setTimeout(() => void poll(), Math.max(50, intervalMs));
    }
  }
  void poll();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
