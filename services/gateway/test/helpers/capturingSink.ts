import type { MeterSink } from "../../src/metering/sinks.js";
import type { MeterRecord } from "../../src/metering/sinks.js";

/** Test sink capturing every meter record for assertions. */
export class CapturingSink implements MeterSink {
  readonly name = "capturing";
  readonly records: MeterRecord[] = [];

  async record(entry: MeterRecord): Promise<void> {
    this.records.push(entry);
  }

  async flush(): Promise<void> {
    /* nothing buffered */
  }
}
