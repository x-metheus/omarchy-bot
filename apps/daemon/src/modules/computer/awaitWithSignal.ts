import { addAbortListener } from "node:events";

/** Cancel a request's wait for a shared operation such as desktop startup or the input seat. */
export async function awaitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    throw signal.reason;
  }
  const aborted = Promise.withResolvers<never>();
  const listener = addAbortListener(signal, () => aborted.reject(signal.reason));
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    listener[Symbol.dispose]();
  }
}
