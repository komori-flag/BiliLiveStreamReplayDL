export class RequestQueue {
  private queue: (() => Promise<void>)[] = [];
  private maxTasks = 20;

  add(task: () => Promise<void>) {
    if (this.queue.length >= this.maxTasks)
      throw new Error('请求队列任务过多，拒绝新任务');
    this.queue.push(task);
    this.run();
  }

  private async run() {
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
      } catch {
        // 指数退避
        const wait = Math.min(5 * 60_000, Math.pow(2, this.queue.length) * 10_000);
        await new Promise(r => setTimeout(r, wait));
        this.queue.push(task); // 重新排队
      }
    }
  }
}
