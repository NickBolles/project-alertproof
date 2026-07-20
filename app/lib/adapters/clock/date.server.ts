import type { Clock } from "../../ports";

export class DateClock implements Clock {
  now(): Date {
    return new Date();
  }
}
