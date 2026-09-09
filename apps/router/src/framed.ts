import type { Duplex } from "node:stream";
import { MessageReader, type RawMessage } from "./protocol.js";

/**
 * Await protocol messages from a socket.
 *
 * The startup and authentication exchanges are a sequence of request/response
 * steps, which reads far better as `await next()` than as a state machine
 * spread across event handlers. Once a connection reaches steady state the
 * router stops framing entirely and pipes raw bytes, so this is only ever on
 * the setup path — its cost does not appear in query latency.
 */
export class FramedStream {
  private readonly reader: MessageReader;
  private resolveNext: ((msg: RawMessage | null) => void) | null = null;
  private rejectNext: ((err: Error) => void) | null = null;
  private ended = false;
  private failure: Error | null = null;
  private detached = false;

  constructor(
    readonly stream: Duplex,
    startupPhase: boolean,
  ) {
    this.reader = new MessageReader(startupPhase);
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.on("close", this.onEnd);
    stream.on("error", this.onError);
  }

  enterMessagePhase(): void {
    this.reader.enterMessagePhase();
  }

  next(): Promise<RawMessage | null> {
    if (this.failure) return Promise.reject(this.failure);

    const ready = this.reader.next();
    if (ready) return Promise.resolve(ready);
    if (this.ended) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      this.resolveNext = resolve;
      this.rejectNext = reject;
    });
  }

  /** Bytes read from the socket but not yet framed. */
  buffered(): Buffer {
    return this.reader.drain();
  }

  /**
   * Stop framing and hand the socket back.
   *
   * Anything already buffered is pushed back onto the stream, so a subsequent
   * `pipe()` sees the exact byte sequence that was on the wire. Skipping this
   * loses whatever arrived in the same TCP segment as the last message — a bug
   * that only shows up under load, when segments are full.
   */
  detach(): Buffer {
    if (this.detached) return Buffer.alloc(0);
    this.detached = true;
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.off("close", this.onEnd);
    this.stream.off("error", this.onError);
    return this.reader.drain();
  }

  private readonly onData = (chunk: Buffer): void => {
    this.reader.push(chunk);
    if (!this.resolveNext) return;

    let message: RawMessage | null;
    try {
      message = this.reader.next();
    } catch (err) {
      this.onError(err as Error);
      return;
    }
    if (!message) return;

    const resolve = this.resolveNext;
    this.resolveNext = null;
    this.rejectNext = null;
    resolve(message);
  };

  private readonly onEnd = (): void => {
    if (this.ended) return;
    this.ended = true;
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      this.rejectNext = null;
      resolve(null);
    }
  };

  private readonly onError = (err: Error): void => {
    this.failure = err;
    this.ended = true;
    if (this.rejectNext) {
      const reject = this.rejectNext;
      this.resolveNext = null;
      this.rejectNext = null;
      reject(err);
    }
  };
}
