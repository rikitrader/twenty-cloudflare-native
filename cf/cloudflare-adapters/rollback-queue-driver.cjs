"use strict";

const {
  CloudflareQueueDriver,
} = require("./queue-driver.cjs");

/**
 * Redis/BullMQ owns new production and schedules during rollback. The
 * consumer-only Cloudflare driver retains the same registered handlers so the
 * previous Queue generation can drain before its ownership window closes.
 */
class RollbackQueueDriver {
  constructor(primary) {
    this.primary = primary;
    this.drain = new CloudflareQueueDriver();
  }

  register(queueName) {
    return this.primary.register(queueName);
  }

  add(queueName, jobName, data, options) {
    return this.primary.add(queueName, jobName, data, options);
  }

  addCron(input) {
    return this.primary.addCron(input);
  }

  removeCron(input) {
    return this.primary.removeCron(input);
  }

  work(queueName, handler) {
    const primaryWorker = this.primary.work(queueName, handler);
    this.drain.work(queueName, handler);
    return primaryWorker;
  }

  async onModuleDestroy() {
    await Promise.all([
      this.primary.onModuleDestroy(),
      this.drain.onModuleDestroy(),
    ]);
  }
}

module.exports = { RollbackQueueDriver };
