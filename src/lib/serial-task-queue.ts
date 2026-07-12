export interface SerialTaskQueue {
  tail: Promise<void>;
}

export function enqueueSerialTask<T>(
  queue: SerialTaskQueue,
  task: () => Promise<T>,
): Promise<T> {
  const result = queue.tail.then(task, task);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}
