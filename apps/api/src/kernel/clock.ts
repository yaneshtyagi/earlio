/** Time always comes from here. Never call Date.now() in domain code. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

/** Virtual clock: allowed only in development / demo / test (Demo Director). */
export class VirtualClock implements Clock {
  private offsetMs = 0;
  private fixed: Date | null = null;
  now() {
    return this.fixed ? new Date(this.fixed) : new Date(Date.now() + this.offsetMs);
  }
  advanceDays(days: number) {
    if (this.fixed) this.fixed = new Date(this.fixed.getTime() + days * 86_400_000);
    else this.offsetMs += days * 86_400_000;
  }
  advanceHours(h: number) {
    if (this.fixed) this.fixed = new Date(this.fixed.getTime() + h * 3_600_000);
    else this.offsetMs += h * 3_600_000;
  }
  setTo(d: Date) {
    this.fixed = d;
  }
  reset() {
    this.offsetMs = 0;
    this.fixed = null;
  }
}
