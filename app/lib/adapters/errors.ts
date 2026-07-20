export class NotConfiguredError extends Error {
  constructor(adapter: string) {
    super(`${adapter} is a typed Phase 0 stub and is not configured yet`);
    this.name = "NotConfiguredError";
  }
}
